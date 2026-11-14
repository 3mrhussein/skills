// `moro sync status|show|accept|skip|fallback`: what changed upstream since each
// upstream skill's pin, and one decision per skill (ADR 0003, ADR 0004, ADR 0007).
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { offerPush, requireRepoIdentity } from "./add.js";
import { checkWarning, impactSummary } from "./check.js";
import { findSet } from "./device.js";
import { UP_TO_DATE } from "./hints.js";
import { frontmatterName } from "./frontmatter.js";
import { type Git, GitError, gitRunner } from "./git.js";
import type { MoroIo } from "./main.js";
import type { Choice } from "./prompter.js";
import { forgetSkill, MANIFEST_FILE, type Manifest, readManifest, type RenameRule, type UpstreamSkill, writeManifest } from "./manifest.js";
import { cloneUrl } from "./ref.js";
import { render, renderName } from "./render.js";
import { existingSkillFolder } from "./set-layout.js";
import { checkout, type Checkout, findSkills, readSkillFiles, type SkillFile } from "./source.js";
import { UserError } from "./user-error.js";
import { MORO_VERSION } from "./version.js";

const USAGE = "moro sync [--yes] | status | show <skill> | accept <skill> | skip <skill> | fallback <skill>";

/** What a decision does to a skill's upstream change. */
export type Decision = "accept" | "skip" | "fallback";

/** Fallback is offered only for a skill with hand edits that upstream still holds: otherwise it equals accept. */
const offersFallback = (skill: Pending) => !skill.removed && skill.handEdits.length > 0;

/** The decision commands for a skill, as a next step names them. */
function decisionCommands(skill: Pending): string {
  const commands = ["accept", "skip", ...(offersFallback(skill) ? ["fallback"] : [])].map((action) => `\`moro sync ${action} ${skill.key}\``);
  return `${commands.slice(0, -1).join(", ")} or ${commands.at(-1)}`;
}

export async function sync(io: MoroIo, argv: string[]): Promise<number> {
  const [action, ...rest] = argv;
  const git = gitRunner(io.env);
  const setDir = findSet(io);
  const manifest = readManifest(setDir, MORO_VERSION);
  switch (action) {
    case undefined:
    case "--yes":
    case "-y":
      if (rest.length > 0) throw usage("sync takes only --yes");
      return interactive(io, git, setDir, manifest, action !== undefined);
    case "status":
      if (rest.length > 0) throw usage("status takes no arguments");
      return status(io, git, setDir, manifest);
    case "show":
    case "accept":
    case "skip":
    case "fallback": {
      if (rest.length !== 1 || rest[0]!.startsWith("-")) throw usage(`${action} takes one skill`);
      const key = rest[0]!;
      if (!Object.hasOwn(manifest.skills, key)) {
        throw new UserError(`${key} is not an upstream skill in the set.\n\nNext: run \`moro sync status\` to see the skills with changes.`);
      }
      if (action === "show") return show(io, git, setDir, manifest, key);
      return decide(io, git, setDir, manifest, key, action);
    }
    default:
      throw usage(`Unknown sync command: ${action}`);
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
  /** Paths where the latest upstream differs from the pin, rendered. */
  upstreamChanges: string[];
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
        `Can't reach ${id} (${source.repo}): ${error.stderr.trim()}\n\nNext: check that this device can read the repo, then rerun.`,
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
  const upstreamChanges = differing(base, theirs);
  const changed = upstreamChanges.length > 0;
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
    upstreamChanges,
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
  newUpstream: { source: string; name: string; path: string }[];
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
  const newUpstream = only ? [] : newUpstreamSkills(manifest, fetches, pending);
  return { fetches, pending, unreachable, newUpstream };
}

function newUpstreamSkills(manifest: Manifest, fetches: Fetches, pending: Pending[]): Pendings["newUpstream"] {
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

/** The manifest HEAD holds, read without trusting it; undefined when there is none. */
async function committedManifest(git: Git, setDir: string): Promise<Partial<Manifest> | undefined> {
  const committed = await git(["show", `HEAD:${MANIFEST_FILE}`], setDir).catch(() => undefined);
  return committed ? (JSON.parse(committed) as Partial<Manifest>) : undefined;
}

/** Keys whose accept moved the pin but isn't committed yet: conflict markers wait to be resolved. */
async function heldKeys(git: Git, setDir: string, manifest: Manifest): Promise<string[]> {
  const skills = (await committedManifest(git, setDir))?.skills;
  if (!skills) return [];
  return Object.keys(manifest.skills).filter((key) => skills[key] && skills[key]!.pin !== manifest.skills[key]!.pin);
}

/** What says that a skill's accept waits for its markers. */
const heldLine = (key: string) => `${key} is accepted but waiting for its conflict markers to be resolved`;

/** Lines for the skills in the sources that the set doesn't hold, none when there are none. */
function newUpstreamLines(found: Pendings): string[] {
  return found.newUpstream.length === 0
    ? []
    : ["New upstream skills, not added:", ...found.newUpstream.map(({ source, name, path }) => `  ${source}: ${name} (${path})`)];
}

/** Tells on stderr which sources couldn't be reached; true when there were any. */
function reportUnreachable(io: MoroIo, found: Pendings): boolean {
  for (const message of found.unreachable.values()) io.stderr.write(`${message.split("\n\n")[0]}. Its skills are left undecided.\n`);
  return found.unreachable.size > 0;
}

/** `moro sync status`: read-only. It lists what a decision or `moro sync` would do, and changes nothing. */
async function status(io: MoroIo, git: Git, setDir: string, manifest: Manifest): Promise<number> {
  const held = await heldKeys(git, setDir, manifest);
  const reRendered = await sourcesWithNewRules(git, setDir, manifest);
  const found = await pendingSkills(git, setDir, manifest);
  try {
    const pending = found.pending.filter((skill) => !held.includes(skill.key));
    const lines = [
      ...held.map(heldLine),
      ...reRendered.map((id) => `${id}: rename rules changed, so a decision or \`moro sync\` re-renders its skills`),
      ...pending.map((skill) => skillLine(skill)),
    ];
    const out = lines.length > 0 ? [...lines] : found.unreachable.size === 0 ? [UP_TO_DATE] : [];
    const news = newUpstreamLines(found);
    if (news.length > 0) out.push("", ...news);
    const first = pending.find((skill) => !skill.pure);
    if (held.length > 0) {
      out.push("", `Next: resolve the conflict markers, then run \`moro sync accept ${held[0]}\`.`);
    } else if (first) {
      out.push("", `Next: run \`moro sync show ${first.key}\`, then ${decisionCommands(first)}.`);
    } else if (lines.length > 0) {
      out.push("", "Next: run `moro sync`.");
    }
    io.stdout.write(`${out.join("\n")}\n`);
    return reportUnreachable(io, found) ? 1 : 0;
  } finally {
    release(found.fetches);
  }
}

/** `moro sync`: one decision per waiting skill, as a selection; `--yes` takes the defaults and asks nothing. */
async function interactive(io: MoroIo, git: Git, setDir: string, manifest: Manifest, yes: boolean): Promise<number> {
  await requireRepoIdentity(git, setDir);
  await rerender(io, git, setDir, manifest);
  const held = await heldKeys(git, setDir, manifest);
  const found = await pendingSkills(git, setDir, manifest);
  try {
    const pending = (await followMoves(io, git, setDir, manifest, found.pending)).filter((skill) => !held.includes(skill.key));
    const accepted: string[] = [];
    const skipped: string[] = [];
    const fellBack: string[] = [];
    const later: string[] = [];
    const conflicted: { key: string; files: string[] }[] = [];
    for (const [index, skill] of pending.entries()) {
      const merged = skill.removed ? undefined : await mergeSkill(git, skill);
      const conflicts = merged?.conflicts ?? [];
      // Accept is the safe default when it merges cleanly and leaves every hand edit alone.
      const clean = !skill.removed && conflicts.length === 0 && !skill.handEdits.some((path) => skill.upstreamChanges.includes(path));
      let choice: string = clean ? "accept" : "later";
      if (!yes) {
        for (;;) {
          const choices = [
            { value: "accept", label: "Accept: take the upstream changes" },
            { value: "skip", label: "Skip: keep the copy as it is and never ask about these changes" },
            { value: "later", label: "Later: decide next time" },
            { value: "show", label: "Show the diff" },
          ];
          const [accept, skip, later, show] = choices as [Choice, Choice, Choice, Choice];
          // Fallback comes after accept and skip, and is never the default.
          const fallback: Choice[] = offersFallback(skill)
            ? [{ value: "fallback", label: `Fall back: drop your hand edits in ${skill.handEdits.join(", ")} and take the upstream text as it is` }]
            : [];
          const answer = await io.prompter.select({
            message: `${skillLine(skill, conflicts)} (${index + 1} of ${pending.length})\nWhat should happen to ${skill.key}?`,
            // With no safe default, the cautious answers come first.
            choices: clean ? [accept, skip, ...fallback, later, show] : [later, skip, accept, ...fallback, show],
            ...(clean ? { recommended: "accept" } : {}),
          });
          choice = "value" in answer ? answer.value : "later";
          if (choice !== "show") break;
          io.stdout.write(`${await describe(git, setDir, skill)}\n`);
        }
      }
      if (choice === "later") {
        later.push(skill.key);
        continue;
      }
      const files: string[] = [];
      const code = await decide(io, git, setDir, manifest, skill.key, choice as Decision, { conflicts: files });
      if (code !== 0) conflicted.push({ key: skill.key, files });
      else ({ accept: accepted, skip: skipped, fallback: fellBack })[choice as Decision].push(skill.key);
    }

    const out: string[] = [];
    if (accepted.length > 0) out.push(`Accepted: ${accepted.join(", ")}.`);
    if (skipped.length > 0) out.push(`Skipped: ${skipped.join(", ")}.`);
    if (fellBack.length > 0) out.push(`Fell back: ${fellBack.join(", ")}.`);
    for (const key of held) out.push(`${heldLine(key)}.`);
    for (const { key, files } of conflicted) {
      const folder = existingSkillFolder(setDir, key) ?? key;
      out.push(`Conflict in ${files.join(", ")} of ${key}: diff3 markers are in ${folder}, the pin is moved, and nothing is committed for it.`);
    }
    if (later.length > 0) out.push(`Coming back next time: ${later.join(", ")}.`);
    const decided = accepted.length + skipped.length + fellBack.length + later.length + held.length + conflicted.length;
    if (decided === 0 && found.unreachable.size === 0) out.push(UP_TO_DATE);
    out.push(...newUpstreamLines(found));
    if (out.length > 0) io.stdout.write(`${out.join("\n")}\n`);

    let code = reportUnreachable(io, found) ? 1 : 0;
    const warning = accepted.length + fellBack.length > 0 ? checkWarning(setDir) : "";
    if (warning) io.stdout.write(`\n${warning.trimEnd()}\n`);
    if (accepted.length + skipped.length + fellBack.length > 0) {
      io.stdout.write("\n");
      code = (await offerPush(io, git, setDir, yes)) || code;
    }
    const waiting = [...held, ...conflicted.map(({ key }) => key)];
    if (waiting.length > 0) {
      const commands = waiting.map((key) => `\`moro sync accept ${key}\``).join(" and ");
      const rest = later.length > 0 ? ", and `moro sync` again for the rest" : "";
      io.stdout.write(`\nNext: resolve the markers in ${waiting.join(", ")}, then run ${commands} to commit ${waiting.length === 1 ? "it" : "each"}${rest}.\n`);
      code = 1;
    }
    return code;
  } finally {
    release(found.fetches);
  }
}

/** One line on what waits for a skill; `conflicts`, when known, adds whether accepting would conflict. */
function skillLine(skill: Pending, conflicts?: string[]): string {
  const count = `${skill.commits.length} commit${skill.commits.length === 1 ? "" : "s"}`;
  const notes = [
    skill.pure ? "moved, no change to the files" : skill.removed ? "removed upstream" : count,
    ...(skill.moved && !skill.pure ? ["moved"] : []),
    ...(skill.handEdits.length > 0 ? ["hand edits"] : []),
    ...(skill.mentions.length > 0 ? ["new lines naming Matt"] : []),
    ...(conflicts === undefined || skill.removed ? [] : [conflicts.length > 0 ? `accepting would conflict in ${conflicts.join(", ")}` : "merges cleanly"]),
  ];
  return `${skill.key}: ${notes.join(", ")}`;
}

async function show(io: MoroIo, git: Git, setDir: string, manifest: Manifest, key: string): Promise<number> {
  const { fetches, pending } = await pendingSkills(git, setDir, manifest, key);
  try {
    const skill = pending[0];
    if (!skill) {
      io.stdout.write(`${key} has no upstream changes since its pin.\n\nNext: run \`moro sync status\`.\n`);
      return 0;
    }
    io.stdout.write(`${await describe(git, setDir, skill)}\n\nNext: run ${decisionCommands(skill)}.\n`);
    return 0;
  } finally {
    release(fetches);
  }
}

/** What `show` prints for one waiting skill. */
async function describe(git: Git, setDir: string, skill: Pending): Promise<string> {
  const key = skill.key;
  const merged = skill.removed ? undefined : await mergeSkill(git, skill);
  const out = [
    `${key}: ${skill.entry.pin.slice(0, 7)} to ${skill.source.pin.slice(0, 7)} in ${skill.entry.source}`,
    skill.handEdits.length > 0 ? `Hand edits: ${skill.handEdits.join(", ")}` : "Hand edits: none",
    ...(offersFallback(skill) ? ["Fallback drops them and takes the upstream text as it is."] : []),
    impactSummary(setDir, key),
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
  return out.join("\n").trimEnd();
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
  const held = await heldKeys(git, setDir, manifest);
  if (!(await manifestCommitted(git, setDir, held))) return rest;
  await requireRepoIdentity(git, setDir);
  const before = readFileSync(join(setDir, MANIFEST_FILE));
  for (const skill of pure) manifest.skills[skill.key] = { ...skill.entry, path: skill.headPath!, pin: skill.source.pin };
  const message = `sync: follow ${pure.length === 1 ? "move" : "moves"} of ${pure.map((skill) => skill.key).join(", ")}`;
  try {
    await commitPaths(git, setDir, manifest, held, [MANIFEST_FILE], message);
  } catch (error) {
    return rollBack(git, setDir, error, { paths: [MANIFEST_FILE], manifestBefore: before });
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

/** The sources with skills in the set whose rename rules changed since their copies were rendered. */
async function sourcesWithNewRules(git: Git, setDir: string, manifest: Manifest): Promise<string[]> {
  const ids: string[] = [];
  for (const [id, source] of Object.entries(manifest.sources)) {
    const used = Object.values(manifest.skills).some((entry) => entry.source === id);
    if (used && (await previousRules(git, setDir, id, source.rename))) ids.push(id);
  }
  return ids;
}

/**
 * Changing a source's rename rules re-renders its skills by three-way merge at the same pin:
 * base is the pin rendered by the old rules, theirs by the new ones, so the copies don't turn into hand edits.
 * A skill waiting on conflict markers is left as it is.
 */
async function rerender(io: MoroIo, git: Git, setDir: string, manifest: Manifest): Promise<void> {
  const held = await heldKeys(git, setDir, manifest);
  for (const [id, source] of Object.entries(manifest.sources)) {
    const keys = Object.keys(manifest.skills).filter((key) => manifest.skills[key]!.source === id && !held.includes(key));
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
      await requireCommitted(git, setDir, folders, "", held);
      const paths = [...folders, MANIFEST_FILE];
      try {
        for (const { folder, files } of results) replaceFolder(join(setDir, folder), files);
        await commitPaths(git, setDir, manifest, held, paths, `sync: re-render ${id}`, true);
      } catch (error) {
        await rollBack(git, setDir, error, { paths, discard: folders });
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
  action: Decision,
  batch?: { conflicts: string[] },
): Promise<number> {
  await requireRepoIdentity(git, setDir);
  const heldBefore = await heldKeys(git, setDir, manifest);
  // A fallback on an accept that waits for its markers drops the markers with the hand edits: it starts again from the committed pin.
  const dropsMarkers = action === "fallback" && heldBefore.includes(key);
  if (heldBefore.includes(key) && !dropsMarkers) {
    if (action === "skip") {
      throw new UserError(
        `Accepting ${key} is waiting for its conflict markers to be resolved, so it can't be skipped.\n\nNext: resolve the markers, then run \`moro sync accept ${key}\`, or \`moro sync fallback ${key}\` to drop your hand edits and take the upstream text as it is.`,
      );
    }
    return finishAccept(io, git, setDir, manifest, key, heldBefore);
  }
  if (dropsMarkers) {
    const committedPin = (await committedManifest(git, setDir))!.skills![key]!.pin;
    manifest.skills[key] = { ...manifest.skills[key]!, pin: committedPin };
  }
  const held = heldBefore.filter((other) => other !== key);
  await rerender(io, git, setDir, manifest);
  const { fetches, pending: found } = await pendingSkills(git, setDir, manifest, key);
  try {
    const [skill] = await followMoves(io, git, setDir, manifest, found);
    if (!skill) {
      const what = action === "fallback" ? "fall back" : action;
      if (!batch) io.stdout.write(`${key} has no upstream changes since its pin, so there is nothing to ${what}.\n\nNext: run \`moro sync status\`.\n`);
      return 0;
    }
    if (action === "fallback" && skill.removed) {
      throw new UserError(
        `${key} was removed upstream, so there is no upstream text to fall back to. Nothing was changed.\n\nNext: run \`moro sync accept ${key}\` to delete it from the set, or \`moro sync skip ${key}\` to keep it as an own skill.`,
      );
    }
    const paths = action === "skip" ? [MANIFEST_FILE] : [skill.folder, MANIFEST_FILE];
    // The markers of a held accept are what a fallback drops, so its folder may hold them.
    await requireCommitted(git, setDir, dropsMarkers ? [] : [skill.folder], action, heldBefore);

    const merged =
      action === "accept" && !skill.removed
        ? await mergeSkill(git, skill)
        : action === "fallback"
          ? { files: skill.theirs, conflicts: [] }
          : undefined;
    const conflicted = merged !== undefined && merged.conflicts.length > 0;
    // The hand-edited files whose text the fallback replaces.
    const theirs = byPath(skill.theirs);
    const ours = byPath(skill.ours);
    const dropped = action === "fallback" ? skill.handEdits.filter((path) => !sameFile(ours.get(path), theirs.get(path))) : [];
    const message =
      action === "fallback"
        ? `sync: fall back ${key}${dropped.length > 0 ? `\n\nDropped the hand edits in ${dropped.join(", ")}.` : ""}`
        : `sync: ${action} ${key}`;

    const before = readFileSync(join(setDir, MANIFEST_FILE));
    const { pin, skipped } = manifest.skills[key]!;
    if (skill.removed) dropSkill(manifest, key, skill.folder, action === "accept");
    else {
      manifest.skills[key] = {
        ...manifest.skills[key]!,
        path: skill.headPath!,
        pin: skill.source.pin,
        skipped:
          action === "skip" ? [...new Set([...skipped, ...skill.commits.map(({ sha }) => sha)])] : action === "fallback" ? [] : skipped,
      };
    }
    try {
      if (skill.removed && action === "accept") rmSync(join(setDir, skill.folder), { recursive: true, force: true });
      if (merged) replaceFolder(join(setDir, skill.folder), merged.files);
      if (conflicted) writeManifest(setDir, manifest);
      else await commitPaths(git, setDir, manifest, held, paths, message);
    } catch (error) {
      await rollBack(git, setDir, error, { paths, discard: paths, manifestBefore: before });
    }
    if (conflicted && batch) {
      batch.conflicts.push(...merged.conflicts);
      return 1;
    }
    if (conflicted) {
      io.stdout.write(
        `Accepted ${key} with a conflict in ${merged.conflicts.join(", ")}: diff3 markers are in the files, the pin is now ${skill.source.pin.slice(0, 7)}, and nothing is committed.\n\nNext: resolve the markers, then run \`moro sync accept ${key}\` to commit.\n`,
      );
      return 1;
    }
    if (batch) return 0;
    const newPin = skill.source.pin.slice(0, 7);
    const verb = { accept: "Accepted", skip: "Skipped", fallback: "Fell back" }[action];
    const detail = skill.removed
      ? action === "accept"
        ? "removed upstream, so it is gone from the set"
        : "removed upstream, so it stays in the set as an own skill"
      : action === "accept"
        ? `took the changes since ${pin.slice(0, 7)}, pin now ${newPin}`
        : action === "skip"
          ? `kept the copy as it is, pin now ${newPin}`
          : dropped.length > 0
            ? `dropped the hand edits in ${dropped.join(", ")} and took the upstream text, pin now ${newPin}`
            : `it had no hand edits, so it took the upstream changes as accept would, pin now ${newPin}`;
    io.stdout.write(`${verb} ${key}: ${detail}, in one commit.\n\n${action === "skip" ? "" : checkWarning(setDir)}${await afterDecision(git, setDir)}`);
    return 0;
  } finally {
    release(fetches);
  }
}

const NOT_PUSHED =
  "Not pushed: no device sees this until you push.\nNext: run `moro sync status` for the next skill, then `git push` in the set's clone.\n";

/**
 * The closing lines of a single decision. On a trial's branch nothing needs a push:
 * `moro try <skill> --keep` merges the branch into main, so the next step is comparing the candidates.
 */
async function afterDecision(git: Git, setDir: string): Promise<string> {
  const branch = await git(["branch", "--show-current"], setDir).catch(() => "");
  const trial = /^try\/(.+?)(?:-fallback|-adapted)?$/.exec(branch)?.[1];
  return trial ? `Next: run \`moro try ${trial}\` to compare the candidates again.\n` : NOT_PUSHED;
}

/** What `moro try` finds for a skill in a checkout of main: whether it has an upstream change to try, and of which kind. */
export type ChangeKind = "none" | "moved" | "removed" | "plain" | "hand edits";

export async function changeKind(io: MoroIo, setDir: string, key: string): Promise<ChangeKind> {
  const { fetches, pending } = await pendingSkills(gitRunner(io.env), setDir, readManifest(setDir, MORO_VERSION), key);
  release(fetches);
  const skill = pending[0];
  if (!skill) return "none";
  if (skill.pure) return "moved";
  if (skill.removed) return "removed";
  return offersFallback(skill) ? "hand edits" : "plain";
}

/** An upstream skill as `moro audit` sees it: its source past the pin, and the set's copy against the pin. */
export interface UpstreamStanding {
  source: "up to date" | "changed" | "removed" | "unreachable";
  /** Upstream commits touching the skill since the pin, merges left out; undefined when unreachable. */
  commits: number | undefined;
  /** Paths where the set's copy differs from the pin rendered; undefined when the pin can't be read. */
  handEdits: string[] | undefined;
  /** An upstream change with hand edits, so `moro try` makes both candidates. */
  tryable: boolean;
}

export interface Standings {
  /** Each upstream skill the set holds a folder for, by key. */
  skills: Map<string, UpstreamStanding>;
  /** Source ids that couldn't be reached, with why. */
  unreachable: Map<string, string>;
  /** Skills in the sources that the set doesn't hold. */
  newUpstream: { source: string; name: string; path: string }[];
}

/** Every upstream skill's standing, read-only: what sync would find, plus hand edits where upstream hasn't moved. */
export async function upstreamStandings(io: MoroIo, setDir: string): Promise<Standings> {
  const git = gitRunner(io.env);
  const manifest = readManifest(setDir, MORO_VERSION);
  const found = await pendingSkills(git, setDir, manifest);
  try {
    const skills = new Map<string, UpstreamStanding>();
    for (const [key, entry] of Object.entries(manifest.skills)) {
      const folder = existingSkillFolder(setDir, key);
      if (!folder) continue;
      if (found.unreachable.has(entry.source)) {
        skills.set(key, { source: "unreachable", commits: undefined, handEdits: undefined, tryable: false });
        continue;
      }
      const pending = found.pending.find((skill) => skill.key === key);
      if (pending) {
        skills.set(key, {
          source: pending.removed ? "removed" : "changed",
          commits: pending.commits.length,
          handEdits: pending.handEdits,
          tryable: !pending.pure && offersFallback(pending),
        });
        continue;
      }
      // No upstream change, so hand edits are the set's copy against the pin rendered.
      const rules = manifest.sources[entry.source]!.rename;
      const base = await pinFiles(git, found.fetches.get(entry.source)!.dir, entry).then(
        (files) => render(files, rules, key),
        () => undefined,
      );
      const handEdits = base && differing(base, readSkillFiles(join(setDir, folder)));
      skills.set(key, { source: "up to date", commits: 0, handEdits, tryable: false });
    }
    return { skills, unreachable: found.unreachable, newUpstream: found.newUpstream };
  } finally {
    release(found.fetches);
  }
}

/**
 * One decision on a candidate's worktree, as `moro sync <action> <key>` makes it there, printing nothing.
 * Returns the files an accept left conflict markers in; empty when the decision is committed.
 */
export async function decideQuietly(io: MoroIo, setDir: string, key: string, action: Decision): Promise<string[]> {
  const quiet: MoroIo = { ...io, stdout: { write: () => undefined } };
  const conflicts: string[] = [];
  await decide(quiet, gitRunner(io.env), setDir, readManifest(setDir, MORO_VERSION), key, action, { conflicts });
  return conflicts;
}

/** Removes an upstream skill's entry; on accept, also every mention of it in the set's graph. */
function dropSkill(manifest: Manifest, key: string, folder: string, everywhere: boolean): void {
  if (!everywhere) {
    delete manifest.skills[key];
    return;
  }
  forgetSkill(manifest, key, folder);
  for (const [name, needs] of Object.entries(manifest.dependsOn)) manifest.dependsOn[name] = needs.filter((need) => need !== key);
}

/** The files in a skill's folder that still hold conflict markers. */
export function markedFiles(folder: string): string[] {
  return readSkillFiles(folder)
    .filter((file) => !("symlink" in file) && !file.content.includes(0) && /^(<{7}|>{7}) /m.test(file.content.toString("utf8")))
    .map((file) => file.path);
}

/** Commits an accept that left conflict markers, once none remain. */
async function finishAccept(io: MoroIo, git: Git, setDir: string, manifest: Manifest, key: string, held: string[]): Promise<number> {
  const folder = existingSkillFolder(setDir, key);
  if (!folder) throw new UserError(`The set has no folder for ${key}.`);
  const marked = markedFiles(join(setDir, folder));
  if (marked.length > 0) {
    throw new UserError(
      `Conflict markers are still in ${marked.join(", ")}, so accepting ${key} can't be committed. Nothing was changed.\n\nNext: resolve the markers, then rerun \`moro sync accept ${key}\`.`,
    );
  }
  const paths = [folder, MANIFEST_FILE];
  const before = readFileSync(join(setDir, MANIFEST_FILE));
  try {
    await commitPaths(git, setDir, manifest, held.filter((other) => other !== key), paths, `sync: accept ${key}`);
  } catch (error) {
    await rollBack(git, setDir, error, { paths, manifestBefore: before });
  }
  io.stdout.write(`Accepted ${key}: resolved, pin now ${manifest.skills[key]!.pin.slice(0, 7)}, in one commit.\n\n${await afterDecision(git, setDir)}`);
  return 0;
}

/** Whether the manifest differs from HEAD's only in the pins of held accepts, which wait for their markers. */
async function manifestCommitted(git: Git, setDir: string, held: string[]): Promise<boolean> {
  if ((await git(["status", "--porcelain", "--", MANIFEST_FILE], setDir)) === "") return true;
  const committed = await committedManifest(git, setDir);
  if (held.length === 0 || !committed) return false;
  const without = (manifest: Partial<Manifest>) =>
    JSON.stringify(manifest, (name, value: unknown) => (name === "skills" ? Object.fromEntries(Object.entries(value as object).filter(([key]) => !held.includes(key))) : value));
  const working = JSON.parse(readFileSync(join(setDir, MANIFEST_FILE), "utf8")) as Partial<Manifest>;
  return without(sortKeys(working)) === without(sortKeys(committed));
}

/** The same value with every object's keys sorted, so two manifests compare by content. */
function sortKeys(value: unknown): Partial<Manifest> {
  if (Array.isArray(value)) return value.map(sortKeys) as never;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([name, inner]) => [name, sortKeys(inner)]));
  }
  return value as never;
}

/**
 * A decision commits only its own skill's folder and the manifest, so those can't hold uncommitted work
 * (a held accept's pin in the manifest and its folder's markers aside).
 */
async function requireCommitted(git: Git, setDir: string, folders: string[], action: string, held: string[]): Promise<void> {
  const foldersClean = folders.length === 0 || (await git(["status", "--porcelain", "--", ...folders], setDir)) === "";
  const clean = foldersClean && (await manifestCommitted(git, setDir, held));
  if (clean) return;
  throw new UserError(
    `${[...folders, MANIFEST_FILE].join(" and ")} have uncommitted changes, and a decision makes one commit of its own. Nothing was changed.\n\nNext: commit or discard them, then rerun \`${["moro sync", action].filter(Boolean).join(" ")}\`.`,
  );
}

/**
 * Commits `paths` with the manifest, leaving the pins of held accepts at what HEAD holds:
 * they are committed once their own markers are resolved. The working manifest keeps them.
 */
async function commitPaths(
  git: Git,
  setDir: string,
  manifest: Manifest,
  held: string[],
  paths: string[],
  message: string,
  allowEmpty = false,
): Promise<void> {
  const committed = (await committedManifest(git, setDir))?.skills ?? {};
  const view: Manifest = { ...manifest, skills: { ...manifest.skills } };
  for (const key of held) if (committed[key]) view.skills[key] = committed[key]!;
  writeManifest(setDir, view);
  await git(["add", "-A", "--", ...paths], setDir);
  await git(["commit", "-q", ...(allowEmpty ? ["--allow-empty"] : []), "-m", message, "--", ...paths], setDir);
  writeManifest(setDir, manifest);
}

/** Undoes a failed decision: unstages `paths`, restores `discard` from HEAD and the manifest's bytes, and rethrows. */
async function rollBack(
  git: Git,
  setDir: string,
  error: unknown,
  undo: { paths: string[]; discard?: string[]; manifestBefore?: Buffer },
): Promise<never> {
  await git(["reset", "-q", "--", ...undo.paths], setDir).catch(() => undefined);
  if (undo.discard?.length) await git(["checkout", "-q", "HEAD", "--", ...undo.discard], setDir).catch(() => undefined);
  if (undo.manifestBefore) writeFileSync(join(setDir, MANIFEST_FILE), undo.manifestBefore);
  if (error instanceof GitError) throw new UserError(`Sync changed nothing: ${error.message}`);
  throw error;
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
