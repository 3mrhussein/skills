// `moro setup`: machine setup. Explore first, then one step at a time, each
// led by its recommended answer (on a rerun, the machine's current answer),
// skipping any step with nothing to ask.
import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { type Git, GitError, gitRunner } from "./git.js";
import { installedFrom, isFrom, type LockEntry, readLock } from "./lock.js";
import { type Env, type Locations, readLocations } from "./locations.js";
import { type MachineChoices, readMachine, writeMachine } from "./machine.js";
import type { MoroIo } from "./main.js";
import { askYesNo, type Prompter } from "./prompter.js";
import { runSkills } from "./skills-cli.js";
import { checkout, findSkills } from "./source.js";
import { UserError } from "./user-error.js";

interface SetupArgs {
  /** Ask nothing: take each recommended or current answer. */
  yes: boolean;
  /** Skills to leave out, overriding the skills step's answer. */
  leaveOut: string[] | undefined;
}

/** What setup changed on this machine. */
interface Changes {
  cli: boolean;
  installed: string[];
  removed: string[];
  leftOut: string[];
}

const USAGE = "moro setup [--yes] [--leave-out <skill…>]";
const PACKAGE = "@3mrhussein/moro";
/** The folder of the set the `skills` CLI scans by default; work skills sit outside it. */
const SKILLS_FOLDER = "skills";

export async function setup(io: MoroIo, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const locations = readLocations(io.env);
  const say = (text: string) => io.stdout.write(`${text}\n`);
  const git = gitRunner(io.env);

  // Explore.
  const before = readMachine(locations.machineFile);
  const lock = readLock(locations.lockFile);
  say(stateParagraph(lock, before, locations.setRemote));
  say(await checkGitAccess(git, locations, io.cwd));
  const setSkills = await readSetSkills(git, locations.setRemote);
  for (const name of args.leaveOut ?? []) {
    if (!setSkills.includes(name)) {
      throw new UserError(`The set has no skill named ${name}.\n\nMachine setup changed nothing. The set's skills: ${setSkills.join(", ")}.`);
    }
  }

  const changes: Changes = { cli: false, installed: [], removed: [], leftOut: [] };
  changes.cli = await offerGlobalCli(io, args.yes);

  // Skills: every set skill, ticked unless left out on this machine.
  const leftOutBefore = before?.leftOut ?? [];
  // `--leave-out` is the step's whole answer: it replaces the machine's left-out skills.
  const chosen = args.leaveOut
    ? setSkills.filter((name) => !args.leaveOut!.includes(name))
    : args.yes || setSkills.length === 0
      ? setSkills.filter((name) => !leftOutBefore.includes(name))
      : await askSkills(io.prompter, setSkills, leftOutBefore);
  const installedFromSet = installedFrom(lock, locations.setRemote, SKILLS_FOLDER);
  changes.removed = setSkills.filter((name) => installedFromSet.includes(name) && !chosen.includes(name));
  changes.installed = chosen.filter((name) => !installedFromSet.includes(name));
  const leftOut = [
    ...leftOutBefore.filter((name) => !setSkills.includes(name)),
    ...setSkills.filter((name) => !chosen.includes(name)),
  ];
  changes.leftOut = leftOut.filter((name) => !leftOutBefore.includes(name));

  // The choices are saved first, so a failed install leaves them for the rerun.
  const choices: MachineChoices = { work: before?.work ?? false, leftOut, setRepo: before?.setRepo ?? null };
  writeMachine(locations.machineFile, choices);
  await changeSkills(io.env, locations, "remove", changes.removed);
  await changeSkills(io.env, locations, "add", changes.installed);

  say(`\n${summary(changes, before === undefined)}`);
  return 0;
}

function parseArgs(argv: string[]): SetupArgs {
  let yes = false;
  let leaveOut: string[] | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === "--yes" || arg === "-y") yes = true;
    else if (arg === "--leave-out") {
      leaveOut ??= [];
      while (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("-")) leaveOut.push(argv[++index]!);
      if (leaveOut.length === 0) throw new UserError(`Name the skills to leave out.\n\nNext: run ${USAGE}`);
    } else if (arg.startsWith("-")) throw new UserError(`Unknown option: ${arg}\n\nNext: run ${USAGE}`);
    else throw new UserError(`moro setup takes no ${arg}.\n\nNext: run ${USAGE}`);
  }
  return { yes, leaveOut };
}

/** One paragraph: what's installed and from where, whether this is a work machine, and the set's clone. */
function stateParagraph(lock: Record<string, LockEntry>, machine: MachineChoices | undefined, setRemote: string): string {
  const counts = new Map<string, number>();
  for (const entry of Object.values(lock)) {
    const from = isFrom(entry, setRemote) ? "the set" : entry.source;
    counts.set(from, (counts.get(from) ?? 0) + 1);
  }
  const total = Object.keys(lock).length;
  // The set first, then other sources by name.
  const groups = [...counts]
    .sort(([a], [b]) => Number(b === "the set") - Number(a === "the set") || a.localeCompare(b))
    .map(([from, count]) => `${count} from ${from}`);
  const installed =
    total === 0
      ? "No skills are installed at user level."
      : counts.size === 1
        ? `${total === 1 ? "1 skill is" : `${total} skills are`} installed at user level, ${total === 1 ? "" : total === 2 ? "both " : "all "}from ${[...counts.keys()][0]}.`
        : `${total} skills are installed at user level: ${listed(groups)}.`;
  const work = !machine
    ? "moro hasn't set this machine up, so it isn't a work machine yet."
    : machine.work
      ? "This is a work machine."
      : "This isn't a work machine.";
  const clone = machine?.setRepo ? `The set's clone is at ${machine.setRepo}.` : "No clone of the set is recorded.";
  return `${installed} ${work} ${clone}`;
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Reads the set with terminal prompts off, naming the route that worked, or stops with the checklist. */
async function checkGitAccess(git: Git, locations: Locations, cwd: string): Promise<string> {
  try {
    await git(["ls-remote", locations.setRemote, "HEAD"], cwd);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    throw new UserError(
      [
        `Git can't read the set at ${locations.setRemote}:`,
        `  ${error.stderr.trim().split("\n").join("\n  ")}`,
        "",
        "Machine setup stopped and changed nothing. Give this machine read access, then rerun `moro setup`:",
        "  - a GitHub token in git's credential helper for github.com that can read 3mrhussein/skills",
        "    (a classic token with repo scope, or a fine-grained one with Contents read), or",
        "  - an SSH key on the 3mrhussein GitHub account, with git reaching github.com over SSH.",
        "Machine setup never changes git credentials.",
      ].join("\n"),
    );
  }
  return `Git can read the set (${await route(git, locations.setRemote, cwd)}).`;
}

/** How git reached the set: the remote after git's URL rewrites, and for HTTPS whether a credential helper is set. */
async function route(git: Git, remote: string, cwd: string): Promise<string> {
  const url = await git(["ls-remote", "--get-url", remote], cwd).catch(() => remote);
  if (/^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(url)) return "over SSH";
  if (!/^https?:\/\//.test(url)) return `from ${url}`;
  const helper = await git(["config", "--get-urlmatch", "credential.helper", url], cwd).catch(() => "");
  return helper ? "over HTTPS, with git's credential helper" : "over HTTPS";
}

/** The names of the set's skills outside `work/`, sorted. */
async function readSetSkills(git: Git, setRemote: string): Promise<string[]> {
  const set = await checkout(git, setRemote, undefined).catch((error: unknown) => {
    if (error instanceof GitError) throw new UserError(`Can't read the set: ${error.stderr.trim()}\n\nMachine setup changed nothing.`);
    throw error;
  });
  try {
    return findSkills(set.dir, SKILLS_FOLDER)
      .map((skill) => skill.name)
      .sort((a, b) => a.localeCompare(b));
  } finally {
    set.remove();
  }
}

/** Offers the global CLI when `moro` isn't on the PATH, default yes; true when it was installed. */
async function offerGlobalCli(io: MoroIo, yes: boolean): Promise<boolean> {
  if (onPath(io.env, "moro")) return false;
  const message = `moro isn't on your PATH, so hints saying \`moro …\` won't run. Install it with \`npm i -g ${PACKAGE}\`?`;
  if (!yes && !(await askYesNo(io.prompter, message, "yes"))) return false;
  await new Promise<void>((resolve, reject) => {
    execFile("npm", ["i", "-g", PACKAGE], { env: io.env, cwd: io.cwd }, (error, stdout, stderr) => {
      if (!error) return resolve();
      reject(
        new UserError(
          [
            `\`npm i -g ${PACKAGE}\` failed: ${(stderr || stdout || error.message).trim()}`,
            "",
            "Machine setup stopped before changing any skills. Next: fix npm, or rerun `moro setup` and answer no.",
          ].join("\n"),
        ),
      );
    });
  });
  return true;
}

/**
 * Whether `command` is on the PATH as a global install. `npx` and npm scripts
 * put a `node_modules/.bin` first on the PATH, which a new shell won't have,
 * so those folders don't count.
 */
function onPath(env: Env, command: string): boolean {
  return (env.PATH ?? "").split(delimiter).some((dir) => {
    if (!dir || /[\\/]node_modules[\\/]\.bin[\\/]?$/.test(dir)) return false;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

async function askSkills(prompter: Prompter, setSkills: string[], leftOut: string[]): Promise<string[]> {
  return prompter.multiSelect({
    message: "Which of the set's skills should this machine have?",
    choices: setSkills.map((name) => ({ value: name, label: name, ...(leftOut.includes(name) ? {} : { picked: true }) })),
  });
}

/**
 * Installs from the set, or removes, at user level. Installs pass no `-a`, so
 * the `skills` CLI picks the agents itself.
 */
async function changeSkills(env: Env, locations: Locations, change: "add" | "remove", names: string[]): Promise<void> {
  if (names.length === 0) return;
  const args = change === "add" ? ["add", locations.setRemote, "-g", "-y", "--skill", ...names] : ["remove", "-g", "-y", ...names];
  const result = await runSkills(args, { env, cwd: locations.home });
  if (result.code !== 0) {
    const doing = change === "add" ? "Installing" : "Removing";
    throw new UserError(`${doing} ${names.join(", ")} failed:\n${result.output.trim()}\n\nNext: rerun \`moro setup\`.`);
  }
}

function summary(changes: Changes, firstRun: boolean): string {
  const lines = [
    ...(changes.cli ? [`Installed the moro CLI (${PACKAGE}).`] : []),
    ...(changes.installed.length > 0 ? [`Installed: ${changes.installed.join(", ")}.`] : []),
    ...(changes.removed.length > 0 ? [`Removed: ${changes.removed.join(", ")}.`] : []),
    ...(changes.leftOut.length > 0 ? [`Left out: ${changes.leftOut.join(", ")}.`] : []),
  ];
  if (firstRun) return [...lines, "", "Next: open a project and run `/setup-moro-skills`"].join("\n").trimStart();
  return lines.length > 0 ? lines.join("\n") : "Up to date.";
}
