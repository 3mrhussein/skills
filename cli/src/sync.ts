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
  /** The skill's folder in the source at its latest commit; undefined when upstream removed it. */
  headPath: string | undefined;
  /** Upstream removed the skill. */
  removed: boolean;
  /** The skill's folder in the source changed. */
  moved: boolean;
  /** Moved with no change to the rendered files: followed without asking. */
  pure: boolean;
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
  /** New upstream lines that still name Matt after the rename rules. */
  mentions: string[];
}

type Fetches = Map<string, Checkout>;

/** A source that couldn't be cloned. */
class UnreachableError extends UserError {}

async function fetchSource(git: Git, manifest: Manifest, id: string): Promise<Checkout> {
  const source = manifest.sources[id]!;
  return checkout(git, cloneUrl(source.repo), undefined).catch((error: unknown) => {
    if (error instanceof GitError) {
      throw new UnreachableError(
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
  if (!folder) return undefined;

  const base = render(await pinFiles(git, source.dir, entry), rules, key);
  const theirs = headPath === undefined ? [] : render(readSkillFiles(join(source.dir, headPath)), rules, key);
  const removed = headPath === undefined;
  const moved = headPath !== undefined && headPath !== entry.path;
  const changed = differing(base, theirs).length > 0;
  if (!removed && !moved && !changed) return undefined;
  const ours = readSkillFiles(join(setDir, folder));
  const log = await git(
    ["log", "--no-merges", "--reverse", "--format=%H%x09%s", `${entry.pin}..${source.pin}`, "--", ...new Set([entry.path, headPath ?? entry.path])],
    source.dir,
  );
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split("\t");
      return { sha: sha!, subject: subject.join("\t") };
    });
  return {
    key,
    entry,
    rules,
    source,
    headPath,
    removed,
    moved,
    pure: moved && !changed,
    folder,
    base,
    theirs,
    ours,
    commits,
    handEdits: differing(base, ours),
    mentions: newMentions(base, theirs),
  };
}

/** The new lines upstream added that still name Matt, after the rename rules. */
function newMentions(base: SkillFile[], theirs: SkillFile[]): string[] {
  const before = byPath(base);
  const out: string[] = [];
  for (const file of theirs) {
    if ("symlink" in file || file.content.includes(0)) continue;
    const old = before.get(file.path);
    const known = new Set(old && !("symlink" in old) ? old.content.toString("utf8").split("\n") : []);
    for (const line of file.content.toString("utf8").split("\n")) {
      if (!known.has(line) && /\b(matt|pocock)\b/i.test(line)) out.push(`${file.path}: ${line.trim().slice(0, 110)}`);
    }
  }
  return out;
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

interface Pendings {
  fetches: Fetches;
  pending: Pending[];
  /** Source ids that couldn't be reached, with why; their skills are left undecided. */
  unreachable: Map<string, string>;
  /** Skills in the sources that the set doesn't hold: an FYI, never added. */
  fresh: { source: string; name: string; path: string }[];
}

/**
 * Fetches the sources of the skills (all, or `only`), and lists those with changes since their pin.
 * An unreachable source is reported and its skills skipped, unless a single skill was asked for.
 */
async function pendingSkills(git: Git, setDir: string, manifest: Manifest, only?: string): Promise<Pendings> {
  const fetches: Fetches = new Map();
  const unreachable = new Map<string, string>();
  const pending: Pending[] = [];
  try {
    for (const key of Object.keys(manifest.skills).filter((candidate) => !only || candidate === only)) {
      const id = manifest.skills[key]!.source;
      if (unreachable.has(id)) continue;
      if (!fetches.has(id)) {
        try {
          fetches.set(id, await fetchSource(git, manifest, id));
        } catch (error) {
          if (!(error instanceof UnreachableError) || only) throw error;
          unreachable.set(id, error.message);
          continue;
        }
      }
      const found = await inspect(git, setDir, manifest, fetches.get(id)!, key);
      if (found) pending.push(found);
    }
  } catch (error) {
    release(fetches);
    throw error;
  }
  const fresh = only ? [] : newSkills(manifest, fetches, pending);
  return { fetches, pending, unreachable, fresh };
}

function newSkills(manifest: Manifest, fetches: Fetches, pending: Pending[]): Pendings["fresh"] {
  return [...fetches].flatMap(([id, source]) => {
    const tracked = new Set(
      Object.entries(manifest.skills)
        .filter(([, entry]) => entry.source === id)
        .map(([key, entry]) => pending.find((skill) => skill.key === key)?.headPath ?? entry.path),
    );
    return findSkills(source.dir)
      .filter((skill) => !tracked.has(skill.path))
      .map((skill) => ({ source: id, name: skill.name, path: skill.path }));
  });
}

function release(fetches: Fetches): void {
  for (const source of fetches.values()) source.remove();
}

/** Keys whose accept moved the pin but isn't committed yet: conflict markers wait to be resolved. */
async function heldKeys(git: Git, setDir: string, manifest: Manifest): Promise<string[]> {
  const committed = await git(["show", `HEAD:${MANIFEST_FILE}`], setDir).catch(() => undefined);
  if (!committed) return [];
  const skills = (JSON.parse(committed) as Partial<Manifest>).skills ?? {};
  return Object.keys(manifest.skills).filter((key) => skills[key] && skills[key]!.pin !== manifest.skills[key]!.pin);
}

async function status(io: MoroIo, git: Git, setDir: string, manifest: Manifest): Promise<number> {
  await rerender(io, git, setDir, manifest);
  const held = await heldKeys(git, setDir, manifest);
  const found = await pendingSkills(git, setDir, manifest);
  try {
    const pending = await followMoves(io, git, setDir, manifest, found.pending);
    const lines = [
      ...held.map((key) => `${key}: accept waits for its conflict markers to be resolved`),
      ...pending.map((skill) => {
        const count = `${skill.commits.length} commit${skill.commits.length === 1 ? "" : "s"}`;
        const flags = [
          skill.removed ? "removed upstream" : count,
          ...(skill.moved ? ["moved"] : []),
          ...(skill.handEdits.length > 0 ? ["hand edits"] : []),
          ...(skill.mentions.length > 0 ? ["new lines naming Matt"] : []),
        ];
        return `${skill.key}: ${flags.join(", ")}`;
      }),
    ];
    const out: string[] = [];
    if (lines.length > 0) out.push(...lines);
    else if (found.unreachable.size === 0) out.push("Up to date.");
    if (found.fresh.length > 0) {
      out.push("", "New upstream skills, not added:", ...found.fresh.map(({ source, name, path }) => `  ${source}: ${name} (${path})`));
    }
    const first = held[0] ?? pending[0]?.key;
    if (held.length > 0) {
      out.push("", `Next: resolve the conflict markers, then run \`moro sync accept ${held[0]}\`.`);
    } else if (first) {
      out.push("", `Next: run \`moro sync show ${first}\`, then \`moro sync accept ${first}\` or \`moro sync skip ${first}\`.`);
    }
    io.stdout.write(`${out.join("\n")}\n`);
    for (const message of found.unreachable.values()) io.stderr.write(`${message.split("\n\n")[0]}. Its skills are left undecided.\n`);
    return found.unreachable.size > 0 ? 1 : 0;
  } finally {
    release(found.fetches);
  }
}

async function show(io: MoroIo, git: Git, setDir: string, manifest: Manifest, key: string): Promise<number> {
  const { fetches, pending } = await pendingSkills(git, setDir, manifest, key);
  try {
    const skill = pending[0];
    if (!skill) {
      io.stdout.write(`${key} has no upstream changes since its pin.\n\nNext: run \`moro sync status\`.\n`);
      return 0;
    }
    const merged = skill.removed ? undefined : await mergeSkill(git, skill);
    const out = [
      `${key}: ${skill.entry.pin.slice(0, 7)} to ${skill.source.pin.slice(0, 7)} in ${skill.entry.source}`,
      skill.handEdits.length > 0 ? `Hand edits: ${skill.handEdits.join(", ")}` : "Hand edits: none",
    ];
    if (skill.removed) {
      out.push(`Removed upstream: accept deletes ${skill.folder} from the set, skip keeps it as an own skill.`);
    } else {
      if (skill.moved) out.push(`Moved: ${skill.entry.path} to ${skill.headPath}`);
      out.push(merged!.conflicts.length > 0 ? `Accept would conflict in: ${merged!.conflicts.join(", ")}` : "Accept merges cleanly.");
    }
    if (skill.mentions.length > 0) {
      out.push("Warning: new upstream lines still name Matt, and no rename rule covers them:", ...skill.mentions.map((line) => `  ${line}`));
    }
    out.push("", "Commits", ...skill.commits.map(({ sha, subject }) => `  ${sha.slice(0, 7)} ${subject}`));
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

/** Skills that only moved upstream are followed without asking: one commit moves their paths and pins. */
async function followMoves(io: MoroIo, git: Git, setDir: string, manifest: Manifest, pending: Pending[]): Promise<Pending[]> {
  const pure = pending.filter((skill) => skill.pure);
  if (pure.length === 0) return pending;
  const rest = pending.filter((skill) => !skill.pure);
  if ((await git(["status", "--porcelain", "--", MANIFEST_FILE], setDir)) !== "") return rest;
  await requireRepoIdentity(git, setDir);
  const before = readFileSync(join(setDir, MANIFEST_FILE));
  for (const skill of pure) manifest.skills[skill.key] = { ...skill.entry, path: skill.headPath!, pin: skill.source.pin };
  try {
    writeManifest(setDir, manifest);
    await git(["add", "--", MANIFEST_FILE], setDir);
    await git(["commit", "-q", "-m", `sync: follow ${pure.length === 1 ? "move" : "moves"} of ${pure.map((skill) => skill.key).join(", ")}`, "--", MANIFEST_FILE], setDir);
  } catch (error) {
    await git(["reset", "-q", "--", MANIFEST_FILE], setDir).catch(() => undefined);
    writeFileSync(join(setDir, MANIFEST_FILE), before);
    if (error instanceof GitError) throw new UserError(`Sync changed nothing: ${error.message}`);
    throw error;
  }
  io.stdout.write(`Followed ${pure.map((skill) => `${skill.key} (${skill.entry.path} to ${skill.headPath})`).join(", ")}: moved upstream with no change to the files.\n`);
  return rest;
}

/**
 * The rules a source's copies were last rendered with, when the manifest's rules have changed since:
 * the newest rules in the manifest's history that differ from the current ones, unless a re-render
 * already followed the change.
 */
async function previousRules(git: Git, setDir: string, id: string, current: RenameRule[]): Promise<RenameRule[] | undefined> {
  const rulesAt = async (sha: string): Promise<RenameRule[] | undefined> => {
    const text = await git(["show", `${sha}:${MANIFEST_FILE}`], setDir).catch(() => undefined);
    return text ? (JSON.parse(text) as Partial<Manifest>).sources?.[id]?.rename : undefined;
  };
  const differs = (rules: RenameRule[]) => JSON.stringify(rules) !== JSON.stringify(current);
  // A change not committed yet.
  const committed = await rulesAt("HEAD");
  if (committed && differs(committed)) return committed;
  // The re-render commit leaves the manifest alone, so it's found by its subject.
  const marker = await git(["log", "-1", "--format=%H", "--fixed-strings", `--grep=sync: re-render ${id}`], setDir).catch(() => "");
  const log = await git(["log", "--format=%H", "--", MANIFEST_FILE], setDir).catch(() => "");
  for (const sha of log.split("\n").filter(Boolean)) {
    if (marker && (await git(["merge-base", "--is-ancestor", sha, marker], setDir).then(() => true, () => false))) return undefined;
    const rules = await rulesAt(sha);
    if (!rules) return undefined;
    if (differs(rules)) return rules;
  }
  return undefined;
}

/**
 * Changing a source's rename rules re-renders its skills by three-way merge at the same pin:
 * base is the pin rendered by the old rules, theirs by the new ones, so the copies don't turn into hand edits.
 */
async function rerender(io: MoroIo, git: Git, setDir: string, manifest: Manifest): Promise<void> {
  for (const [id, source] of Object.entries(manifest.sources)) {
    const keys = Object.keys(manifest.skills).filter((key) => manifest.skills[key]!.source === id);
    if (keys.length === 0) continue;
    const old = await previousRules(git, setDir, id, source.rename);
    if (!old) continue;
    const fetched = await fetchSource(git, manifest, id).catch((error: unknown) => {
      if (error instanceof UnreachableError) return undefined;
      throw error;
    });
    if (!fetched) continue;
    try {
      const folders: string[] = [];
      const results: { folder: string; files: SkillFile[] }[] = [];
      for (const key of keys) {
        const folder = existingSkillFolder(setDir, key);
        if (!folder) continue;
        const raw = await pinFiles(git, fetched.dir, manifest.skills[key]!);
        const merged = await mergeFiles(git, render(raw, old, key), readSkillFiles(join(setDir, folder)), render(raw, source.rename, key));
        if (merged.conflicts.length > 0) {
          throw new UserError(
            `The new rename rules of ${id} conflict with your edits to ${key} in ${merged.conflicts.join(", ")}. Nothing was changed.\n\nNext: resolve them by hand, then rerun \`moro sync\`.`,
          );
        }
        folders.push(folder);
        results.push({ folder, files: merged.files });
      }
      await requireRepoIdentity(git, setDir);
      await requireCommitted(git, setDir, folders, "status");
      const paths = [...folders, MANIFEST_FILE];
      try {
        for (const { folder, files } of results) replaceFolder(join(setDir, folder), files);
        await git(["add", "-A", "--", ...paths], setDir);
        await git(["commit", "-q", "--allow-empty", "-m", `sync: re-render ${id}`, "--", ...paths], setDir);
      } catch (error) {
        await git(["reset", "-q", "--", ...paths], setDir).catch(() => undefined);
        await git(["checkout", "-q", "HEAD", "--", ...folders], setDir).catch(() => undefined);
        if (error instanceof GitError) throw new UserError(`Sync changed nothing: ${error.message}`);
        throw error;
      }
      io.stdout.write(`Re-rendered ${keys.join(", ")} from ${id} with its new rename rules, in one commit.\n`);
    } finally {
      fetched.remove();
    }
  }
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
  if ((await heldKeys(git, setDir, manifest)).includes(key)) {
    if (action === "skip") {
      throw new UserError(
        `Accepting ${key} is waiting for its conflict markers to be resolved, so it can't be skipped.\n\nNext: resolve the markers, then run \`moro sync accept ${key}\`.`,
      );
    }
    return finishAccept(io, git, setDir, manifest, key);
  }
  await rerender(io, git, setDir, manifest);
  const { fetches, pending: found } = await pendingSkills(git, setDir, manifest, key);
  try {
    const [skill] = await followMoves(io, git, setDir, manifest, found);
    if (!skill) {
      io.stdout.write(`${key} has no upstream changes since its pin, so there is nothing to ${action}.\n\nNext: run \`moro sync status\`.\n`);
      return 0;
    }
    const paths = action === "accept" ? [skill.folder, MANIFEST_FILE] : [MANIFEST_FILE];
    await requireCommitted(git, setDir, [skill.folder, MANIFEST_FILE], action);

    const merged = action === "accept" && !skill.removed ? await mergeSkill(git, skill) : undefined;
    const conflicted = merged !== undefined && merged.conflicts.length > 0;

    const before = readFileSync(join(setDir, MANIFEST_FILE));
    const { pin, skipped } = manifest.skills[key]!;
    if (skill.removed) dropSkill(manifest, key, skill.folder, action === "accept");
    else {
      manifest.skills[key] = {
        ...manifest.skills[key]!,
        path: skill.headPath!,
        pin: skill.source.pin,
        skipped: action === "skip" ? [...new Set([...skipped, ...skill.commits.map(({ sha }) => sha)])] : skipped,
      };
    }
    try {
      if (skill.removed && action === "accept") rmSync(join(setDir, skill.folder), { recursive: true, force: true });
      if (merged) replaceFolder(join(setDir, skill.folder), merged.files);
      writeManifest(setDir, manifest);
      if (!conflicted) {
        await git(["add", "-A", "--", ...paths], setDir);
        await git(["commit", "-q", "-m", `sync: ${action} ${key}`, "--", ...paths], setDir);
      }
    } catch (error) {
      await git(["reset", "-q", "--", ...paths], setDir).catch(() => undefined);
      await git(["checkout", "-q", "HEAD", "--", ...paths], setDir).catch(() => undefined);
      writeFileSync(join(setDir, MANIFEST_FILE), before);
      if (error instanceof GitError) throw new UserError(`Sync changed nothing: ${error.message}`);
      throw error;
    }
    if (conflicted) {
      io.stdout.write(
        `Accepted ${key} with a conflict in ${merged.conflicts.join(", ")}: diff3 markers are in the files, the pin is now ${skill.source.pin.slice(0, 7)}, and nothing is committed.\n\nNext: resolve the markers, then run \`moro sync accept ${key}\` to commit.\n`,
      );
      return 1;
    }
    const verb = action === "accept" ? "Accepted" : "Skipped";
    const detail = skill.removed
      ? action === "accept"
        ? "removed upstream, so it is gone from the set"
        : "removed upstream, so it stays in the set as an own skill"
      : action === "accept"
        ? `took the changes since ${pin.slice(0, 7)}, pin now ${skill.source.pin.slice(0, 7)}`
        : `kept the copy as it is, pin now ${skill.source.pin.slice(0, 7)}`;
    io.stdout.write(
      `${verb} ${key}: ${detail}, in one commit.\n\nNot pushed: no machine sees this until you push.\nNext: run \`moro sync status\` for the next skill, then \`git push\` in the set's clone.\n`,
    );
    return 0;
  } finally {
    release(fetches);
  }
}

/** Removes an upstream skill's entry; on accept, also every mention of it in the set's graph. */
function dropSkill(manifest: Manifest, key: string, folder: string, everywhere: boolean): void {
  delete manifest.skills[key];
  if (!everywhere) return;
  manifest.recommended = manifest.recommended.filter((path) => path !== folder);
  if (manifest.required) manifest.required = manifest.required.filter((path) => path !== folder);
  delete manifest.dependsOn[key];
  for (const [name, needs] of Object.entries(manifest.dependsOn)) manifest.dependsOn[name] = needs.filter((need) => need !== key);
}

/** Commits an accept that left conflict markers, once none remain. */
async function finishAccept(io: MoroIo, git: Git, setDir: string, manifest: Manifest, key: string): Promise<number> {
  const folder = existingSkillFolder(setDir, key);
  if (!folder) throw new UserError(`The set has no folder for ${key}.`);
  const marked = readSkillFiles(join(setDir, folder))
    .filter((file) => !("symlink" in file) && !file.content.includes(0) && /^(<{7}|>{7}) /m.test(file.content.toString("utf8")))
    .map((file) => file.path);
  if (marked.length > 0) {
    throw new UserError(
      `Conflict markers are still in ${marked.join(", ")}, so accepting ${key} can't be committed. Nothing was changed.\n\nNext: resolve the markers, then rerun \`moro sync accept ${key}\`.`,
    );
  }
  const paths = [folder, MANIFEST_FILE];
  try {
    await git(["add", "-A", "--", ...paths], setDir);
    await git(["commit", "-q", "-m", `sync: accept ${key}`, "--", ...paths], setDir);
  } catch (error) {
    await git(["reset", "-q", "--", ...paths], setDir).catch(() => undefined);
    if (error instanceof GitError) throw new UserError(`Sync changed nothing: ${error.message}`);
    throw error;
  }
  io.stdout.write(
    `Accepted ${key}: resolved, pin now ${manifest.skills[key]!.pin.slice(0, 7)}, in one commit.\n\nNot pushed: no machine sees this until you push.\nNext: run \`moro sync status\` for the next skill, then \`git push\` in the set's clone.\n`,
  );
  return 0;
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
function mergeSkill(git: Git, skill: Pending): Promise<{ files: SkillFile[]; conflicts: string[] }> {
  return mergeFiles(git, skill.base, skill.ours, skill.theirs);
}

async function mergeFiles(
  git: Git,
  baseFiles: SkillFile[],
  oursFiles: SkillFile[],
  theirsFiles: SkillFile[],
): Promise<{ files: SkillFile[]; conflicts: string[] }> {
  const base = byPath(baseFiles);
  const ours = byPath(oursFiles);
  const theirs = byPath(theirsFiles);
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
