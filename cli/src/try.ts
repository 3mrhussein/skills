// `moro try <skill>`: a trial of a skill's candidates (ADR 0007). Each candidate is a branch of the
// clone off main, in its own worktree beside the clone, made by the same sync code a decision runs:
// the fallback in one, accept (the adapted copy) in the other. main stays as it is until one is kept.
import { existsSync, mkdtempSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireRepoIdentity } from "./add.js";
import { type Finding, impactOf, impactSummary, type Reach, workflowCheck } from "./check.js";
import { findClone } from "./device.js";
import { type Git, GitError, gitRunner } from "./git.js";
import type { MoroIo } from "./main.js";
import { MANIFEST_FILE, readManifest } from "./manifest.js";
import { askYesNo } from "./prompter.js";
import { existingSkillFolder } from "./set-layout.js";
import { changeKind, decideQuietly, markedFiles } from "./sync.js";
import { UserError } from "./user-error.js";
import { MORO_VERSION } from "./version.js";

const USAGE = "moro try <skill> [--json] | moro try <skill> --keep [fallback|adapted] [--yes] | moro try <skill> --drop";
const MAIN = "main";

/** A candidate's name: the fallback and the adapted copy, or `accept` alone for a skill without hand edits. */
type CandidateName = "fallback" | "adapted" | "accept";

interface Candidate {
  name: CandidateName;
  branch: string;
  worktree: string;
}

/** What the trial shows of one candidate, as `--json` prints it. */
interface CandidateView extends Candidate {
  /** Whether the worktree has nothing uncommitted. */
  committed: boolean;
  /** Files of the skill that still hold conflict markers. */
  conflicts: string[];
  /** The skill's folder in the worktree against main's copy. */
  diff: string;
  findings: Finding[];
  impact: Reach[];
  install: string;
}

interface TryArgs {
  key: string;
  json: boolean;
  /** The candidate to keep; "" when `--keep` names none. */
  keep?: string;
  drop: boolean;
  yes: boolean;
}

export async function trySkill(io: MoroIo, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const git = gitRunner(io.env);
  const clone = findClone(io);
  const open = await openTrial(git, clone, args.key);
  if (args.keep !== undefined || args.drop) {
    if (!open) throw new UserError(`${args.key} has no trial open.\n\nNext: run \`moro try ${args.key}\` to start one.`);
    return endTrial(io, git, clone, args, open);
  }
  if (open) return report(io, git, clone, args, open, true);
  return report(io, git, clone, args, await startTrial(io, git, clone, args.key), false);
}

function parseArgs(argv: string[]): TryArgs {
  const args: Partial<TryArgs> & { json: boolean; drop: boolean; yes: boolean } = { json: false, drop: false, yes: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") args.json = true;
    else if (arg === "--drop") args.drop = true;
    else if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--keep") {
      const next = argv[i + 1];
      args.keep = next === "fallback" || next === "adapted" || next === "accept" ? argv[++i]! : "";
    } else if (arg.startsWith("-")) throw usage(`Unknown option: ${arg}`);
    else if (args.key !== undefined) throw usage("try takes one skill");
    else args.key = arg;
  }
  if (args.key === undefined) throw usage("try takes one skill");
  if (args.keep !== undefined && args.drop) throw usage("Give --keep or --drop, not both");
  return args as TryArgs;
}

function usage(problem: string): UserError {
  return new UserError(`${problem}.\n\nNext: run ${USAGE}`);
}

/** The folder beside the clone that holds the trials' worktrees. */
const trialsDir = (clone: string) => `${clone}-try`;

function candidatesFor(clone: string, key: string, handEdits: boolean): Candidate[] {
  if (!handEdits) return [{ name: "accept", branch: `try/${key}`, worktree: join(trialsDir(clone), key) }];
  return (["fallback", "adapted"] as const).map((name) => ({ name, branch: `try/${key}-${name}`, worktree: join(trialsDir(clone), `${key}-${name}`) }));
}

/** The skill's open trial, from its branches; each worktree where git has it checked out. */
async function openTrial(git: Git, clone: string, key: string): Promise<Candidate[] | undefined> {
  const listed = await git(["branch", "--list", "--format=%(refname:short)", `try/${key}`, `try/${key}-fallback`, `try/${key}-adapted`], clone);
  const branches = listed.split("\n").filter(Boolean);
  const pair = candidatesFor(clone, key, true).filter((candidate) => branches.includes(candidate.branch));
  const found = pair.length > 0 ? pair : candidatesFor(clone, key, false).filter((candidate) => branches.includes(candidate.branch));
  if (found.length === 0) return undefined;
  const checkedOut = await worktreesByBranch(git, clone);
  return found.map((candidate) => ({ ...candidate, worktree: checkedOut.get(candidate.branch) ?? candidate.worktree }));
}

async function worktreesByBranch(git: Git, clone: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let path = "";
  for (const line of (await git(["worktree", "list", "--porcelain"], clone)).split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("branch refs/heads/")) out.set(line.slice("branch refs/heads/".length), path);
  }
  return out;
}

/** Makes the candidates' branches and worktrees off main and runs each one's decision there. */
async function startTrial(io: MoroIo, git: Git, clone: string, key: string): Promise<Candidate[]> {
  await requireRepoIdentity(git, clone);
  const kind = await changeOnMain(io, git, clone, key);
  if (kind === "none") throw new UserError(`${key} has no upstream changes since its pin, so there is nothing to try.\n\nNext: run \`moro sync status\`.`);
  if (kind === "moved") {
    throw new UserError(`${key} only moved upstream, with no change to its files, so there is nothing to try.\n\nNext: run \`moro sync\`, which follows the move.`);
  }
  if (kind === "removed") {
    throw new UserError(
      `${key} was removed upstream, so there is no upstream text to try.\n\nNext: run \`moro sync accept ${key}\` to delete it from the set, or \`moro sync skip ${key}\` to keep it as an own skill.`,
    );
  }
  const candidates = candidatesFor(clone, key, kind === "hand edits");
  try {
    for (const candidate of candidates) {
      await git(["worktree", "add", "-q", "-b", candidate.branch, candidate.worktree, MAIN], clone);
      // The adapted copy is today's accept; its conflict markers stay for the owner.
      await decideQuietly(io, candidate.worktree, key, candidate.name === "fallback" ? "fallback" : "accept");
    }
  } catch (error) {
    await removeCandidates(git, clone, candidates);
    throw error;
  }
  return candidates;
}

/** The skill's upstream change as main holds it, read in a throwaway worktree of main. */
async function changeOnMain(io: MoroIo, git: Git, clone: string, key: string): Promise<string> {
  const tree = join(mkdtempSync(join(tmpdir(), "moro-main-")), "main");
  try {
    await git(["worktree", "add", "-q", "--detach", tree, MAIN], clone);
    if (!Object.hasOwn(readManifest(tree, MORO_VERSION).skills, key)) {
      throw new UserError(`${key} is not an upstream skill in the set.\n\nNext: run \`moro sync status\` to see the skills with changes.`);
    }
    return await changeKind(io, tree, key);
  } finally {
    await git(["worktree", "remove", "--force", tree], clone).catch(() => undefined);
    rmSync(join(tree, ".."), { recursive: true, force: true });
    await git(["worktree", "prune"], clone).catch(() => undefined);
  }
}

async function view(git: Git, clone: string, key: string, candidate: Candidate): Promise<CandidateView> {
  const { worktree } = candidate;
  // A worktree folder deleted by hand comes back from its branch.
  if (!existsSync(worktree)) {
    await git(["worktree", "prune"], clone);
    await git(["worktree", "add", "-q", worktree, candidate.branch], clone);
  }
  const folder = existingSkillFolder(worktree, key);
  const check = workflowCheck(worktree);
  return {
    ...candidate,
    committed: (await git(["status", "--porcelain"], worktree)) === "",
    conflicts: folder ? markedFiles(join(worktree, folder)) : [],
    diff: folder ? await git(["diff", "--no-color", MAIN, "--", folder], worktree) : "",
    findings: check.findings,
    impact: check.skills.some((skill) => skill.name === key) ? impactOf(check.calls, key) : [],
    install: `moro install --from ${worktree}`,
  };
}

const LABEL: Record<CandidateName, string> = {
  fallback: "Fallback: drops your hand edits and takes the upstream text as it is",
  adapted: "Adapted: your hand edits merged with the upstream change",
  accept: "Accept: KEY has no hand edits, so accept and fallback are the same",
};

async function report(io: MoroIo, git: Git, clone: string, args: TryArgs, candidates: Candidate[], open: boolean): Promise<number> {
  const { key } = args;
  const main = await git(["rev-parse", MAIN], clone);
  const views: CandidateView[] = [];
  for (const candidate of candidates) views.push(await view(git, clone, key, candidate));
  const held = await Promise.all(views.map((one) => waitsForAccept(git, one)));
  const next = nextStep(key, views, held);

  if (args.json) {
    io.stdout.write(`${JSON.stringify({ skill: key, main, candidates: views, next }, null, 2)}\n`);
    return 0;
  }
  const out = [`Trial of ${key}${open ? ", already open," : ""} off main (${main.slice(0, 7)}): main stays as it is until you keep a candidate.`];
  for (const [index, one] of views.entries()) {
    const label = LABEL[one.name].replace("KEY", key);
    const state = one.committed
      ? `. Committed on ${one.branch}.`
      : one.conflicts.length > 0
        ? `, with conflict markers in ${one.conflicts.join(", ")}: resolve them, then run \`moro sync accept ${key}\` in its worktree.`
        : held[index]
          ? `, with uncommitted changes: run \`moro sync accept ${key}\` in its worktree to commit them.`
          : `, with uncommitted changes: commit them in its worktree.`;
    const count = one.findings.length;
    out.push(
      "",
      `${label}${state}`,
      `Worktree: ${one.worktree}`,
      "Diff against main:",
      one.diff || "  (none)",
      count === 0 ? "Workflow check: no findings." : `Workflow check: ${count} finding${count === 1 ? "" : "s"}:`,
      ...one.findings.map((finding) => `  ${finding.message}`),
      impactSummary(one.worktree, key),
      `Try it in a project: ${one.install}`,
    );
  }
  out.push("", next);
  io.stdout.write(`${out.join("\n")}\n`);
  return 0;
}

/** Whether a candidate's accept is held: its manifest moved the pin and isn't committed yet. */
async function waitsForAccept(git: Git, one: CandidateView): Promise<boolean> {
  return !one.committed && (await git(["status", "--porcelain", "--", MANIFEST_FILE], one.worktree)) !== "";
}

function nextStep(key: string, views: CandidateView[], held: boolean[]): string {
  const keeps = views.filter((one) => one.committed).map((one) => `\`moro try ${key} --keep${one.name === "accept" ? "" : ` ${one.name}`}\``);
  const waiting = views.findIndex((one) => !one.committed);
  if (waiting >= 0) {
    const one = views[waiting]!;
    const first =
      one.conflicts.length > 0
        ? `resolve the markers in ${one.worktree}, then run \`moro sync accept ${key}\` there`
        : held[waiting]
          ? `run \`moro sync accept ${key}\` in ${one.worktree}`
          : `commit the changes in ${one.worktree}`;
    return `Next: ${first}${keeps.length > 0 ? `; or run ${keeps.join(" or ")}` : ""}.`;
  }
  const install = views.length === 1 ? `\`${views[0]!.install}\` in a trial project` : "each candidate's `moro install --from` line in a trial project";
  return `Next: run ${install}, then ${keeps.join(" or ")}, or \`moro try ${key} --drop\` to keep main as it is.`;
}

/** `--keep` merges one candidate into main; `--drop` keeps main as it is. Both remove the trial's worktrees and branches. */
async function endTrial(io: MoroIo, git: Git, clone: string, args: TryArgs, open: Candidate[]): Promise<number> {
  const { key } = args;
  let kept: Candidate | undefined;
  if (args.keep !== undefined) {
    const names = open.map((one) => one.name);
    kept = args.keep === "" ? (open.length === 1 ? open[0] : undefined) : open.find((one) => one.name === args.keep);
    if (!kept) {
      const options = open.map((one) => `\`moro try ${key} --keep ${one.name}\``).join(" or ");
      throw new UserError(`${args.keep ? `The trial of ${key} has no ${args.keep} candidate` : `The trial of ${key} has ${names.join(" and ")}`}, so say which to keep.\n\nNext: run ${options}.`);
    }
    if (existsSync(kept.worktree) && (await git(["status", "--porcelain"], kept.worktree)) !== "") {
      throw new UserError(
        `The ${kept.name} candidate has uncommitted changes in ${kept.worktree}, so it can't be kept yet. Nothing was changed.\n\nNext: resolve the markers, then run \`moro sync accept ${key}\` in that worktree.`,
      );
    }
    const branch = await git(["branch", "--show-current"], clone);
    if (branch !== MAIN) {
      throw new UserError(
        `The set's clone is on ${branch || "a detached HEAD"}, and keeping a candidate merges it into main. Nothing was changed.\n\nNext: run \`git switch main\` in the set's clone, then rerun \`moro try ${key} --keep ${kept.name}\`.`,
      );
    }
    await requireRepoIdentity(git, clone);
    try {
      await git(["merge", "-q", "--no-edit", "-m", `try: keep the ${kept.name} ${key}`, kept.branch], clone);
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      await git(["merge", "--abort"], clone).catch(() => undefined);
      throw new UserError(
        `Merging ${kept.branch} into main failed: ${error.stderr.trim()}\nNothing was changed.\n\nNext: commit or stash the clone's changes, then rerun \`moro try ${key} --keep ${kept.name}\`.`,
      );
    }
  }

  const remote = await remoteBranches(git, clone, open);
  await removeCandidates(git, clone, open);
  if (!kept) {
    const deletes = remote.length > 0 ? `run \`git push origin --delete ${remote.join(" ")}\` in the set's clone, then ` : "run ";
    io.stdout.write(
      `Dropped the trial of ${key}: removed its worktrees and branches; main is as it was.\n\nNext: ${deletes}/setup-moro-skills in each trial project to bring it back to main.\n`,
    );
    return 0;
  }
  const what = kept.name === "accept" ? `${key}'s upstream change` : `the ${kept.name} ${key}`;
  io.stdout.write(`Kept ${what}: merged ${kept.branch} into main, and removed the trial's worktrees and branches.\n\n`);
  return pushMain(io, git, clone, remote, args.yes);
}

/** The trial's branches that origin holds, from a push in a candidate's worktree. */
async function remoteBranches(git: Git, clone: string, candidates: Candidate[]): Promise<string[]> {
  const refs = await git(["for-each-ref", "--format=%(refname:lstrip=3)", "refs/remotes/origin/try/"], clone);
  const held = new Set(refs.split("\n"));
  return candidates.map((one) => one.branch).filter((branch) => held.has(branch));
}

/** Removes the candidates' worktrees, uncommitted changes and all, their branches, and the trials' folder once empty. */
async function removeCandidates(git: Git, clone: string, candidates: Candidate[]): Promise<void> {
  for (const { worktree, branch } of candidates) {
    if (existsSync(worktree)) await git(["worktree", "remove", "--force", worktree], clone);
    await git(["branch", "-q", "-D", branch], clone).catch(() => undefined);
  }
  await git(["worktree", "prune"], clone);
  const dir = trialsDir(clone);
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

/** "Push now?" for main, deleting the trial's branches from origin with it. */
async function pushMain(io: MoroIo, git: Git, clone: string, remote: string[], yes: boolean): Promise<number> {
  const deletes = remote.map((branch) => `:${branch}`);
  if (!yes && !(await askYesNo(io.prompter, "Push now?", "yes"))) {
    io.stdout.write(
      `Not pushed: no device sees this until you push.\n\nNext: run \`git push origin ${[MAIN, ...deletes].join(" ")}\` in the set's clone, then /setup-moro-skills in each project that should get the change.\n`,
    );
    return 0;
  }
  try {
    await git(["push", "-q", "origin", MAIN, ...deletes], clone);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    io.stderr.write(
      `The push failed: ${error.stderr.trim()}\n\nThe merge is in the set's clone. Next: run \`git pull --rebase\` and \`git push\` in the set's clone.\n`,
    );
    return 1;
  }
  const pushed = remote.length > 0 ? `Pushed main and deleted ${remote.join(", ")} from origin.` : "Pushed main.";
  io.stdout.write(`${pushed}\n\nNext: run /setup-moro-skills in each project that should get the change; in a trial project that brings it back to main.\n`);
  return 0;
}
