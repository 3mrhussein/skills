// The test world: a temporary home with its own git config, local bare repos
// standing in for the set and for sources, and `moro` run in-process.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { onTestFinished } from "vitest";
import { main } from "../src/main.js";
import type { Env } from "../src/locations.js";
import { type Answer, type Prompter, recommendedFirst, type SelectRequest } from "../src/prompter.js";
import { runSkills, type SkillsResult } from "../src/skills-cli.js";

/** The fake host that the world's git config rewrites to its local bare repos. */
const HOST = "https://git.moro.test/";

export type Files = Record<string, string>;

/** A scripted answer: a choice by its value, or a typed answer. */
export type ScriptedAnswer = string | { typed: string };

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Every selection prompt `moro` asked, in order. */
  prompts: SelectRequest[];
}

export interface Repo {
  /** The URL `moro` and the `skills` CLI use for this repo. */
  url: string;
  /** Commits `files` on the default branch and pushes; returns the full SHA. */
  commit(files: Files, message?: string): string;
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
  /** Runs the real, pinned `skills` CLI in the world. */
  skills(args: string[], options?: { cwd?: string }): Promise<SkillsResult>;
  /** The user-level lock, or undefined when nothing is installed. */
  readLock(): Lock | undefined;
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
    `[url "file://${remotes}/"]\n\tinsteadOf = ${HOST}\n`,
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
        git(["push", "-q", "origin", "main"], work);
        return git(["rev-parse", "HEAD"], work);
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
  };
}

export function writeFiles(dir: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

/** A `SKILL.md` with frontmatter. */
export function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: Use for ${name}.\n---\n\nThe ${name} skill.\n`;
}

/** Answers each prompt from the script, in order, and fails on anything unexpected. */
function scriptedPrompter(script: ScriptedAnswer[]): Prompter & {
  asked: SelectRequest[];
  remaining(): number;
} {
  const queue = [...script];
  const asked: SelectRequest[] = [];
  return {
    asked,
    remaining: () => queue.length,
    async select(request): Promise<Answer> {
      asked.push(request);
      recommendedFirst(request);
      const next = queue.shift();
      if (next === undefined) throw new Error(`Unscripted prompt: ${request.message}`);
      if (typeof next === "object") {
        if (!request.allowTyped) throw new Error(`Prompt takes no typed answer: ${request.message}`);
        return { typed: next.typed };
      }
      if (!request.choices.some((choice) => choice.value === next)) {
        throw new Error(`"${next}" is not a choice in: ${request.message}`);
      }
      return { value: next };
    },
  };
}
