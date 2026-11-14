// The test world: a temporary home with its own git config, local bare repos
// standing in for the set and for sources, and `moro` run in-process.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import { main } from "../src/main.js";
import type { Env } from "../src/locations.js";
import { type Answer, type MultiSelectRequest, type Prompter, recommendedFirst, type SelectRequest } from "../src/prompter.js";
import { runSkills, type SkillsResult } from "../src/skills-cli.js";

/**
 * A fake host the world's git config rewrites to its local bare repos. GitHub URLs
 * are rewritten to the same repos, so `owner/repo` refs never leave the machine.
 */
const HOST = "https://git.moro.test/";

/** The global git identity, standing in for the company one on the owner's machine. */
export const GLOBAL_IDENTITY = "Company Name <someone@company.test>";
/** The repo-level identity of the set's clone. */
export const SET_IDENTITY = "3mrhussein <owner@moro.test>";

/** Files by path: text, or text with a mode, or a symlink's target. */
export type Files = Record<string, string | { content: string | Buffer; mode?: number } | { symlink: string }>;

/** A scripted answer: a choice by its value, a typed answer, or the values picked in a multi-select. */
export type ScriptedAnswer = string | { typed: string } | string[];

export type Prompt = SelectRequest | MultiSelectRequest;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Every selection prompt `moro` asked, in order. */
  prompts: Prompt[];
}

export interface Repo {
  /** The URL `moro` and the `skills` CLI use for this repo. */
  url: string;
  /** Commits `files` on the default branch and pushes; returns the full SHA. */
  commit(files: Files, message?: string): string;
  /** The full SHA of the default branch's latest commit. */
  head(): string;
  /** Tags the latest commit and pushes the tag. */
  tag(name: string): void;
  /** Commits `files` on a new branch off the default one and pushes it; returns the full SHA. */
  branch(name: string, files: Files): string;
}

export interface World {
  root: string;
  home: string;
  /** A project folder outside the home, the default folder commands run in. */
  project: string;
  /** The environment `moro` and the tools it runs see. */
  env: Env;
  /** The stand-in for `3mrhussein/skills`. */
  set: Repo;
  /** Creates a source repo, e.g. `source("mattpocock/skills", files)`. */
  source(name: string, files: Files): Repo;
  run(argv: string[], options?: { answers?: ScriptedAnswer[]; cwd?: string }): Promise<RunResult>;
  /** Clones the set, once; returns the clone's path. */
  cloneSet(options?: { identity?: boolean }): string;
  /** Runs git in the world; returns trimmed stdout. */
  git(args: string[], cwd: string): string;
  /** Runs the real, pinned `skills` CLI in the world. */
  skills(args: string[], options?: { cwd?: string }): Promise<SkillsResult>;
  /** The user-level lock, or undefined when nothing is installed. */
  readLock(): Lock | undefined;
  /** The device file, or undefined when there is none: nothing writes it until a test bootstraps. */
  readDeviceFile(): any;
  /** A clone of the set (its repo-level identity set), made on first use. */
  readonly clone: string;
  /** Writes the device file as `./install.sh` would, for tests that need a device but aren't about bootstrapping. */
  recordClone(clone?: string): void;
}

export interface Lock {
  version: number;
  skills: Record<string, { source: string; sourceUrl: string; skillPath: string }>;
}

const IDENTITY = ["-c", "user.name=world", "-c", "user.email=world@moro.test"];

export function createWorld(options: { set?: Files } = {}): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "moro-world-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));

  const home = join(root, "home");
  const remotes = join(root, "remotes");
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(remotes);
  const project = join(root, "project");
  mkdirSync(project);
  writeFileSync(
    join(home, ".gitconfig"),
    [
      `[url "file://${remotes}/"]`,
      `\tinsteadOf = ${HOST}`,
      `\tinsteadOf = https://github.com/`,
      `\tinsteadOf = git@github.com:`,
      `[user]`,
      `\tname = Company Name`,
      `\temail = someone@company.test`,
      "",
    ].join("\n"),
  );

  // Built from scratch so nothing from the real machine leaks in.
  const env: Env = {
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    HOME: home,
    MORO_SET_REMOTE: `${HOST}3mrhussein/skills.git`,
    MORO_NPM_REGISTRY: "https://registry.moro.test/",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    DO_NOT_TRACK: "1",
  };

  const git = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git(["init", "-q", "-b", "main"], project);

  let repoCount = 0;
  const createRepo = (name: string, files: Files): Repo => {
    const work = join(root, "work", String(repoCount++));
    mkdirSync(work, { recursive: true });
    git(["init", "-q", "-b", "main"], work);
    const bare = join(remotes, `${name}.git`);
    mkdirSync(dirname(bare), { recursive: true });
    git(["init", "-q", "--bare", "-b", "main", bare], work);
    git(["remote", "add", "origin", bare], work);
    const repo: Repo = {
      url: `${HOST}${name}.git`,
      commit(files, message = "change") {
        writeFiles(work, files);
        git(["add", "-A"], work);
        git([...IDENTITY, "commit", "-q", "--allow-empty", "-m", message], work);
        git(["push", "-q", "origin", "HEAD"], work);
        return git(["rev-parse", "HEAD"], work);
      },
      head: () => git(["rev-parse", "HEAD"], work),
      branch(name, files) {
        git(["checkout", "-q", "-b", name], work);
        const sha = repo.commit(files);
        git(["push", "-q", "origin", name], work);
        git(["checkout", "-q", "main"], work);
        return sha;
      },
      tag(name) {
        git(["tag", name], work);
        git(["push", "-q", "origin", name], work);
      },
    };
    repo.commit(files, "initial");
    return repo;
  };

  return {
    root,
    home,
    project,
    env,
    set: createRepo("3mrhussein/skills", options.set ?? {}),
    source: createRepo,
    git,
    get clone() {
      return this.cloneSet();
    },
    recordClone(clone = join(root, "clone")) {
      mkdirSync(join(home, ".config", "moro"), { recursive: true });
      writeFileSync(join(home, ".config", "moro", "config.json"), `${JSON.stringify({ clone })}\n`);
    },
    cloneSet({ identity = true } = {}) {
      const clone = join(root, "clone");
      if (existsSync(clone)) return clone;
      git(["clone", "-q", `${HOST}3mrhussein/skills.git`, clone], root);
      if (identity) {
        git(["config", "user.name", "3mrhussein"], clone);
        git(["config", "user.email", "owner@moro.test"], clone);
      }
      return clone;
    },
    async run(argv, { answers = [], cwd = project } = {}) {
      let stdout = "";
      let stderr = "";
      const prompter = scriptedPrompter(answers);
      const code = await main({
        argv,
        env,
        cwd,
        stdout: { write: (text) => void (stdout += text) },
        stderr: { write: (text) => void (stderr += text) },
        prompter,
      });
      if (prompter.remaining() > 0) {
        throw new Error(`${prompter.remaining()} scripted answer(s) were never asked for`);
      }
      return { code, stdout, stderr, prompts: prompter.asked };
    },
    skills: (args, { cwd = project } = {}) => runSkills(args, { env, cwd }),
    readLock() {
      try {
        return JSON.parse(readFileSync(join(home, ".agents", ".skill-lock.json"), "utf8")) as Lock;
      } catch {
        return undefined;
      }
    },
    readDeviceFile() {
      try {
        return JSON.parse(readFileSync(join(home, ".config", "moro", "config.json"), "utf8"));
      } catch {
        return undefined;
      }
    },
  };
}

export function writeFiles(dir: string, files: Files): void {
  for (const [path, file] of Object.entries(files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    if (typeof file === "string") writeFileSync(target, file);
    else if ("symlink" in file) symlinkSync(file.symlink, target);
    else {
      writeFileSync(target, file.content);
      if (file.mode !== undefined) chmodSync(target, file.mode);
    }
  }
}

/** The set's manifest in a clone, as parsed JSON. */
export function readManifest(clone: string): any {
  return JSON.parse(readFileSync(join(clone, "manifest.json"), "utf8"));
}

/** A `SKILL.md` with frontmatter. */
export function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\nThe ${name} skill.\n`;
}

/** Answers each prompt from the script, in order, and fails on anything unexpected. */
function scriptedPrompter(script: ScriptedAnswer[]): Prompter & {
  asked: Prompt[];
  remaining(): number;
} {
  const queue = [...script];
  const asked: Prompt[] = [];
  return {
    asked,
    remaining: () => queue.length,
    async select(request): Promise<Answer> {
      asked.push(request);
      recommendedFirst(request);
      const next = queue.shift();
      if (next === undefined) throw new Error(`Unscripted prompt: ${request.message}`);
      if (Array.isArray(next)) throw new Error(`Prompt picks one, not several: ${request.message}`);
      if (typeof next === "object") {
        if (!request.allowTyped) throw new Error(`Prompt takes no typed answer: ${request.message}`);
        return { typed: next.typed };
      }
      if (!request.choices.some((choice) => choice.value === next)) {
        throw new Error(`"${next}" is not a choice in: ${request.message}`);
      }
      return { value: next };
    },
    async multiSelect(request): Promise<string[]> {
      asked.push(request);
      const next = queue.shift();
      if (next === undefined) throw new Error(`Unscripted prompt: ${request.message}`);
      if (!Array.isArray(next)) throw new Error(`Prompt picks several, not one: ${request.message}`);
      for (const value of next) {
        const choice = request.choices.find((candidate) => candidate.value === value);
        if (!choice) throw new Error(`"${value}" is not a choice in: ${request.message}`);
        if (choice.disabled) throw new Error(`"${value}" is greyed out in: ${request.message}`);
      }
      return request.choices.filter((choice) => next.includes(choice.value)).map((choice) => choice.value);
    },
  };
}
