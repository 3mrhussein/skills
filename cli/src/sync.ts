// `moro sync status|show|accept|skip`: what changed upstream since each
// upstream skill's pin, and one decision per skill (ADR 0003, ADR 0004).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findClone, requireRepoIdentity } from "./add.js";
import { frontmatterName } from "./frontmatter.js";
import { type Git, GitError, gitRunner } from "./git.js";
import type { MoroIo } from "./main.js";
import { MANIFEST_FILE, type Manifest, readManifest, type RenameRule, type UpstreamSkill, writeManifest } from "./manifest.js";
import { cloneUrl } from "./ref.js";
import { render, renderName } from "./render.js";
import { existingSkillFolder } from "./set-layout.js";
import { checkout, type Checkout, findSkills, readSkillFiles, type SkillFile } from "./source.js";
import { UserError } from "./user-error.js";
import { MORO_VERSION } from "./version.js";

const USAGE = "moro sync status | show <skill> | accept <skill> | skip <skill>";

export async function sync(io: MoroIo, argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  const git = gitRunner(io.env);
  const setDir = findClone(io);
  const manifest = readManifest(setDir, MORO_VERSION);
  switch (action) {
    case "status":
      if (rest.length > 0) throw usage("status takes no arguments");
      return status(io, git, setDir, manifest);
    case "show":
    case "accept":
    case "skip": {
      if (rest.length !== 1 || rest[0]!.startsWith("-")) throw usage(`${action} takes one skill`);
      const key = rest[0]!;
      if (!Object.hasOwn(manifest.skills, key)) {
        throw new UserError(`${key} is not an upstream skill in the set.\n\nNext: run \`moro sync status\` to see the skills with changes.`);
      }
      if (action === "show") return show(io, git, setDir, manifest, key);
      return decide(io, git, setDir, manifest, key, action);
    }
    default:
      throw usage(action ? `Unknown sync command: ${action}` : "Name a sync command");
  }
}

function usage(problem: string): UserError {
  return new UserError(`${problem}.\n\nNext: run ${USAGE}`);
}

/** What the source's latest commit holds for one upstream skill, next to the pin and the set's copy. */
interface Pending {
  key: string;
  entry: UpstreamSkill;
  rules: RenameRule[];
  /** The source's checkout, for reading commits. */
  source: Checkout;
  /** The skill's folder in the source at its latest commit. */
  headPath: string;
  /** The set's folder for the skill. */
  folder: string;
  /** The source at the pin, rendered. */
  base: SkillFile[];
  /** The source's latest commit, rendered. */
  theirs: SkillFile[];
  /** The set's copy. */
  ours: SkillFile[];
  /** Upstream commits touching the skill since the pin, merges left out, oldest first. */
  commits: { sha: string; subject: string }[];
  /** Paths where the set's copy differs from the pin, rendered: the hand edits. */
  handEdits: string[];
}

type Fetches = Map<string, Checkout>;

async function fetchSource(git: Git, manifest: Manifest, id: string): Promise<Checkout> {
  const source = manifest.sources[id]!;
  return checkout(git, cloneUrl(source.repo), undefined).catch((error: unknown) => {
    if (error instanceof GitError) {
      throw new UserError(
        `Can't reach ${id} (${source.repo}): ${error.stderr.trim()}\n\nNext: check that this machine can read the repo, then rerun.`,
      );
    }
    throw error;
  });
}

async function inspect(git: Git, setDir: string, manifest: Manifest, source: Checkout, key: string): Promise<Pending | undefined> {
  const entry = manifest.skills[key]!;
  const rules = manifest.sources[entry.source]!.rename;
  const atPin = await git(["show", `${entry.pin}:${entry.path}/SKILL.md`], source.dir).catch(() => undefined);
  const name = atPin === undefined ? undefined : frontmatterName(atPin);
  if (!name || entry.pin === source.pin) return undefined;

  // The skill is followed by its upstream name, so a move doesn't hide it.
  const found = findSkills(source.dir);
  const headPath = (found.find((skill) => skill.path === entry.path && skill.name === name) ?? found.find((skill) => skill.name === name))?.path;
  const folder = existingSkillFolder(setDir, key);
  if (!headPath || !folder) return undefined;

  const base = render(await pinFiles(git, source.dir, entry), rules, key);
  const theirs = render(readSkillFiles(join(source.dir, headPath)), rules, key);
  if (differing(base, theirs).length === 0) return undefined;
  const ours = readSkillFiles(join(setDir, folder));
  const log = await git(
    ["log", "--no-merges", "--reverse", "--format=%H%x09%s", `${entry.pin}..${source.pin}`, "--", ...new Set([entry.path, headPath])],
    source.dir,
  );
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split("\t");
      return { sha: sha!, subject: subject.join("\t") };
    });
  return { key, entry, rules, source, headPath, folder, base, theirs, ours, commits, handEdits: differing(base, ours) };
}

/** The skill's files at the pin, read from a throwaway checkout of the pin. */
async function pinFiles(git: Git, dir: string, entry: UpstreamSkill): Promise<SkillFile[]> {
  const tree = mkdtempSync(join(tmpdir(), "moro-pin-"));
  try {
    await git(["worktree", "add", "-q", "--detach", tree, entry.pin], dir);
    return readSkillFiles(join(tree, entry.path));
  } finally {
    rmSync(tree, { recursive: true, force: true });
    await git(["worktree", "prune"], dir).catch(() => undefined);
  }
}

/** Fetches the sources of the skills (all, or `only`), and lists those with changes since their pin. */
async function pendingSkills(
  git: Git,
  setDir: string,
  manifest: Manifest,
  only?: string,
): Promise<{ fetches: Fetches; pending: Pending[] }> {
  const fetches: Fetches = new Map();
  const pending: Pending[] = [];
  try {
    for (const key of Object.keys(manifest.skills).filter((candidate) => !only || candidate === only)) {
      const id = manifest.skills[key]!.source;
      if (!fetches.has(id)) fetches.set(id, await fetchSource(git, manifest, id));
      const found = await inspect(git, setDir, manifest, fetches.get(id)!, key);
      if (found) pending.push(found);
    }
  } catch (error) {
    release(fetches);
    throw error;
  }
  return { fetches, pending };
}

function release(fetches: Fetches): void {
  for (const source of fetches.values()) source.remove();
}

async function status(io: MoroIo, git: Git, setDir: string, manifest: Manifest): Promise<number> {
  const { fetches, pending } = await pendingSkills(git, setDir, manifest);
  release(fetches);
  if (pending.length === 0) {
    io.stdout.write("Up to date.\n");
    return 0;
  }
  const lines = pending.map(({ key, commits, handEdits }) => {
    const count = `${commits.length} commit${commits.length === 1 ? "" : "s"}`;
    return `${key}: ${count}${handEdits.length > 0 ? ", hand edits" : ""}`;
  });
  const first = pending[0]!.key;
  io.stdout.write(
    `${lines.join("\n")}\n\nNext: run \`moro sync show ${first}\`, then \`moro sync accept ${first}\` or \`moro sync skip ${first}\`.\n`,
  );
  return 0;
}

async function show(io: MoroIo, git: Git, setDir: string, manifest: Manifest, key: string): Promise<number> {
  const { fetches, pending } = await pendingSkills(git, setDir, manifest, key);
  try {
    const skill = pending[0];
    if (!skill) {
      io.stdout.write(`${key} has no upstream changes since its pin.\n\nNext: run \`moro sync status\`.\n`);
      return 0;
    }
    const merged = await mergeSkill(git, skill);
    const out = [
      `${key}: ${skill.entry.pin.slice(0, 7)} to ${skill.source.pin.slice(0, 7)} in ${skill.entry.source}`,
      skill.handEdits.length > 0 ? `Hand edits: ${skill.handEdits.join(", ")}` : "Hand edits: none",
      merged.conflicts.length > 0 ? `Accept would conflict in: ${merged.conflicts.join(", ")}` : "Accept merges cleanly.",
      "",
      "Commits",
      ...skill.commits.map(({ sha, subject }) => `  ${sha.slice(0, 7)} ${subject}`),
    ];
    const changesets = await changesetsOf(git, skill);
    if (changesets.length > 0) out.push("", "Changesets", ...changesets.map((text) => `  ${text.replace(/\n+/g, " ")}`));
    out.push("", "Diff", await diffFiles(git, skill.base, skill.theirs));
    io.stdout.write(`${out.join("\n").trimEnd()}\n\nNext: run \`moro sync accept ${key}\` or \`moro sync skip ${key}\`.\n`);
    return 0;
  } finally {
    release(fetches);
  }
}

/** The bodies of the changesets the skill's commits added, with the rename rules applied. */
async function changesetsOf(git: Git, skill: Pending): Promise<string[]> {
  const out: string[] = [];
  for (const { sha } of skill.commits) {
    const names = await git(["diff-tree", "-r", "--no-commit-id", "--name-only", "--diff-filter=A", sha, "--", ".changeset"], skill.source.dir);
    for (const name of names.split("\n").filter((file) => file.endsWith(".md") && !file.endsWith("README.md"))) {
      const text = await git(["show", `${sha}:${name}`], skill.source.dir);
      out.push(renderName(text.replace(/^---[\s\S]*?---\s*/, "").trim(), skill.rules));
    }
  }
  return out;
}

async function decide(
  io: MoroIo,
  git: Git,
  setDir: string,
  manifest: Manifest,
  key: string,
  action: "accept" | "skip",
): Promise<number> {
  await requireRepoIdentity(git, setDir);
  const { fetches, pending } = await pendingSkills(git, setDir, manifest, key);
  try {
    const skill = pending[0];
    if (!skill) {
      io.stdout.write(`${key} has no upstream changes since its pin, so there is nothing to ${action}.\n\nNext: run \`moro sync status\`.\n`);
      return 0;
    }
    const paths = action === "accept" ? [skill.folder, MANIFEST_FILE] : [MANIFEST_FILE];
    await requireCommitted(git, setDir, [skill.folder, MANIFEST_FILE], action);

    const merged = action === "accept" ? await mergeSkill(git, skill) : undefined;
    if (merged && merged.conflicts.length > 0) {
      throw new UserError(
        `Accepting ${key} would conflict in ${merged.conflicts.join(", ")}. Nothing was changed.\n\nNext: run \`moro sync show ${key}\` to see the change.`,
      );
    }

    const before = readFileSync(join(setDir, MANIFEST_FILE));
    const { pin, skipped } = manifest.skills[key]!;
    manifest.skills[key] = {
      ...manifest.skills[key]!,
      path: skill.headPath,
      pin: skill.source.pin,
      skipped: action === "skip" ? [...new Set([...skipped, ...skill.commits.map(({ sha }) => sha)])] : skipped,
    };
    try {
      if (merged) replaceFolder(join(setDir, skill.folder), merged.files);
      writeManifest(setDir, manifest);
      await git(["add", "-A", "--", ...paths], setDir);
      await git(["commit", "-q", "-m", `sync: ${action} ${key}`, "--", ...paths], setDir);
    } catch (error) {
      await git(["reset", "-q", "--", ...paths], setDir).catch(() => undefined);
      await git(["checkout", "-q", "HEAD", "--", ...paths], setDir).catch(() => undefined);
      writeFileSync(join(setDir, MANIFEST_FILE), before);
      if (error instanceof GitError) throw new UserError(`Sync changed nothing: ${error.message}`);
      throw error;
    }
    const verb = action === "accept" ? "Accepted" : "Skipped";
    const detail = action === "accept" ? `took the changes since ${pin.slice(0, 7)}` : "kept the copy as it is";
    io.stdout.write(
      `${verb} ${key}: ${detail}, pin now ${skill.source.pin.slice(0, 7)}, in one commit.\n\nNot pushed: no machine sees this until you push.\nNext: run \`moro sync status\` for the next skill, then \`git push\` in the set's clone.\n`,
    );
    return 0;
  } finally {
    release(fetches);
  }
}

/** A decision commits only its own skill's folder and the manifest, so those can't hold uncommitted work. */
async function requireCommitted(git: Git, setDir: string, paths: string[], action: string): Promise<void> {
  if ((await git(["status", "--porcelain", "--", ...paths], setDir)) === "") return;
  throw new UserError(
    `${paths.join(" and ")} have uncommitted changes, and a decision makes one commit of its own. Nothing was changed.\n\nNext: commit or discard them, then rerun \`moro sync ${action}\`.`,
  );
}

// ---- file sets

/** Replaces a folder's contents with the files. */
function replaceFolder(folder: string, files: SkillFile[]): void {
  rmSync(folder, { recursive: true, force: true });
  writeFiles(folder, files);
}

function writeFiles(folder: string, files: SkillFile[]): void {
  for (const file of files) {
    const target = join(folder, file.path);
    mkdirSync(dirname(target), { recursive: true });
    if ("symlink" in file) symlinkSync(file.symlink, target);
    else {
      writeFileSync(target, file.content);
      chmodSync(target, file.mode);
    }
  }
}

function sameFile(a: SkillFile | undefined, b: SkillFile | undefined): boolean {
  if (!a || !b) return a === b;
  if ("symlink" in a || "symlink" in b) return "symlink" in a && "symlink" in b && a.symlink === b.symlink;
  return a.mode === b.mode && a.content.equals(b.content);
}

const byPath = (files: SkillFile[]) => new Map(files.map((file) => [file.path, file]));

/** The paths that differ between two file sets, sorted. */
function differing(a: SkillFile[], b: SkillFile[]): string[] {
  const left = byPath(a);
  const right = byPath(b);
  return [...new Set([...left.keys(), ...right.keys()])].filter((path) => !sameFile(left.get(path), right.get(path))).sort();
}

/**
 * A per-file three-way merge of the set's copy with the latest upstream, from the pin:
 * a file only upstream changed is taken, one only the owner changed is kept, and one both
 * changed is merged with `git merge-file`, leaving diff3 markers where the edits overlap.
 */
async function mergeSkill(git: Git, skill: Pending): Promise<{ files: SkillFile[]; conflicts: string[] }> {
  const base = byPath(skill.base);
  const ours = byPath(skill.ours);
  const theirs = byPath(skill.theirs);
  const files: SkillFile[] = [];
  const conflicts: string[] = [];
  for (const path of [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort()) {
    const [b, o, t] = [base.get(path), ours.get(path), theirs.get(path)];
    const keep = (file: SkillFile | undefined) => file && files.push(file);
    if (sameFile(b, t) || sameFile(o, t)) keep(o);
    else if (sameFile(b, o)) keep(t);
    else if (!o || !t || !b || "symlink" in o || "symlink" in t || "symlink" in b) {
      // Changed on both sides, with no text to merge.
      conflicts.push(path);
      keep(o ?? t);
    } else {
      const merged = await mergeText(git, b.content, o.content, t.content);
      if (merged.conflicted) conflicts.push(path);
      files.push({ path, content: merged.content, mode: o.mode !== b.mode ? o.mode : t.mode });
    }
  }
  return { files, conflicts };
}

async function mergeText(git: Git, base: Buffer, ours: Buffer, theirs: Buffer): Promise<{ content: Buffer; conflicted: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "moro-merge-"));
  try {
    const [yours, atPin, upstream] = [join(dir, "yours"), join(dir, "base"), join(dir, "upstream")];
    writeFileSync(yours, ours);
    writeFileSync(atPin, base);
    writeFileSync(upstream, theirs);
    // Exits with the number of conflicts, leaving the merge (with markers) in the first file.
    const conflicted = await git(["merge-file", "--diff3", "-L", "yours", "-L", "at the pin", "-L", "upstream", yours, atPin, upstream], dir).then(
      () => false,
      (error: unknown) => {
        if (error instanceof GitError) return true;
        throw error;
      },
    );
    return { content: readFileSync(yours), conflicted };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A git diff from one file set to another, rename rules already applied by the caller. */
async function diffFiles(git: Git, from: SkillFile[], to: SkillFile[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "moro-diff-"));
  try {
    const repo = (args: string[]) => git(["-c", "user.name=moro", "-c", "user.email=moro@invalid", "-c", "commit.gpgsign=false", ...args], dir);
    await repo(["init", "-q", "--template=", "-b", "main"]);
    writeFiles(dir, from);
    await repo(["add", "-A"]);
    await repo(["commit", "-q", "--allow-empty", "-m", "from"]);
    if (from.length > 0) await repo(["rm", "-rq", "--", "."]);
    writeFiles(dir, to);
    await repo(["add", "-A"]);
    return await repo(["diff", "--cached", "--no-color"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
