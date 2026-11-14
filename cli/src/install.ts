// `moro install`: the set's skills, offered in one multi-select and copied into
// the project from the clone. Nothing is recorded in the project beyond what the
// `skills` CLI writes (its `skills-lock.json` and the skill folders).
//
// Later tickets extend `Offer` (required and dependency locks, local-only skills,
// divergence labels) and `offerChoices`; `plan` and `apply` stay as they are.
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readDevice } from "./device.js";
import { gitRunner } from "./git.js";
import { readLocations } from "./locations.js";
import type { MoroIo } from "./main.js";
import { readManifest } from "./manifest.js";
import type { MultiSelectRequest } from "./prompter.js";
import { skillsWithGroups } from "./set-layout.js";
import { runSkills } from "./skills-cli.js";
import { UserError } from "./user-error.js";
import { MORO_VERSION } from "./version.js";

const USAGE = "moro install [--yes]";
const LOCK_FILE = "skills-lock.json";

/** One skill the project can take. */
interface Offer {
  name: string;
  group: string;
  recommended: boolean;
}

export async function install(io: MoroIo, argv: string[]): Promise<number> {
  const yes = parseArgs(argv);
  const git = gitRunner(io.env);
  const top = await projectTop(git, io.cwd);
  const clone = readDevice(readLocations(io.env).deviceFile)!.clone;

  const offers = readOffers(clone);
  if (offers.length === 0) {
    throw new UserError(`The set at ${clone} has no skills to install.\n\nNext: add some with \`moro add\`.`);
  }
  const current = installedSkills(top);
  const firstInstall = current.length === 0;

  const picks = yes
    ? offers.filter((offer) => (firstInstall ? offer.recommended : current.includes(offer.name))).map((offer) => offer.name)
    : await io.prompter.multiSelect(offerChoices(offers, firstInstall ? new Set(offers.filter((o) => o.recommended).map((o) => o.name)) : new Set(current)));

  const { add, remove } = plan(offers, current, picks);

  let keepOut = false;
  if (firstInstall && add.length > 0) {
    keepOut = yes || (await askKeepOut(io));
  }
  const excludeFile = (await git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], top)).trim();
  // A project that kept its skills out of git keeps the new ones out too.
  keepOut ||= !firstInstall && existsSync(excludeFile) && readFileSync(excludeFile, "utf8").split("\n").includes(`/${LOCK_FILE}`);

  await apply(io, { clone, top, add, remove });
  if (keepOut && add.length > 0) excludeFromGit(top, excludeFile, add);

  return summary(io, { add, remove, keepOut });
}

function parseArgs(argv: string[]): boolean {
  let yes = false;
  for (const arg of argv) {
    if (arg === "--yes" || arg === "-y") yes = true;
    else throw new UserError(`Unknown option: ${arg}\n\nNext: run \`${USAGE}\``);
  }
  return yes;
}

/** The project's git top level, from any folder inside it. */
async function projectTop(git: ReturnType<typeof gitRunner>, cwd: string): Promise<string> {
  try {
    return await git(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    throw new UserError(
      "moro install installs into a git project, and this folder isn't in one.\n\nNext: run it inside a git repo, or run `git init` first.",
    );
  }
}

function readOffers(clone: string): Offer[] {
  const manifest = readManifest(clone, MORO_VERSION);
  const recommended = new Set(manifest.recommended.map((path) => basename(path)));
  return skillsWithGroups(clone).map(({ name, group }) => ({ name, group, recommended: recommended.has(name) }));
}

/** The skills in the project's `skills-lock.json`. */
function installedSkills(top: string): string[] {
  try {
    const lock = JSON.parse(readFileSync(join(top, LOCK_FILE), "utf8")) as { skills?: Record<string, unknown> };
    return Object.keys(lock.skills ?? {}).sort();
  } catch {
    return [];
  }
}

/** Recommended skills first, then experimental ones, each under its group; `ticked` start picked. */
function offerChoices(offers: Offer[], ticked: Set<string>): MultiSelectRequest {
  const choice = (offer: Offer, section: string) => ({
    value: offer.name,
    label: offer.name,
    section,
    group: offer.group,
    picked: ticked.has(offer.name),
  });
  return {
    message: "Which skills should this project have?",
    choices: [
      ...offers.filter((offer) => offer.recommended).map((offer) => choice(offer, "Recommended")),
      ...offers.filter((offer) => !offer.recommended).map((offer) => choice(offer, "Experimental")),
    ],
  };
}

async function askKeepOut(io: MoroIo): Promise<boolean> {
  const answer = await io.prompter.select({
    message: "Commit these skills to this project, or keep them out of git?",
    choices: [
      { value: "exclude", label: "Keep them out of git" },
      { value: "commit", label: "Commit them to this project" },
    ],
    recommended: "exclude",
  });
  return "value" in answer && answer.value === "exclude";
}

/** What to add and remove so the project's offered skills match the picks. */
function plan(offers: Offer[], current: string[], picks: string[]): { add: string[]; remove: string[] } {
  const offered = new Set(offers.map((offer) => offer.name));
  return {
    add: picks.filter((name) => !current.includes(name)).sort(),
    // A skill installed from somewhere else isn't the set's to remove.
    remove: current.filter((name) => offered.has(name) && !picks.includes(name)),
  };
}

async function apply(io: MoroIo, work: { clone: string; top: string; add: string[]; remove: string[] }): Promise<void> {
  if (work.add.length > 0) {
    const result = await runSkills(["add", work.clone, "-y", "--skill", ...work.add], { env: io.env, cwd: work.top });
    if (result.code !== 0) {
      throw new UserError(`Installing the skills failed, so nothing was installed.\n\n${result.output.trim()}\n\nNext: fix that, then run \`moro install\` again.`);
    }
  }
  if (work.remove.length > 0) {
    const result = await runSkills(["remove", "-y", ...work.remove], { env: io.env, cwd: work.top });
    if (result.code !== 0) {
      throw new UserError(`Removing the skills failed.\n\n${result.output.trim()}\n\nNext: fix that, then run \`moro install\` again.`);
    }
  }
}

/** Appends the lock and each skill's folders (one per agent folder that holds it) to `.git/info/exclude`. */
function excludeFromGit(top: string, excludeFile: string, names: string[]): void {
  const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8").split("\n") : [];
  const wanted = [`/${LOCK_FILE}`, ...names.flatMap((name) => skillFolders(top, name))];
  const lines = wanted.filter((line) => !existing.includes(line));
  if (lines.length === 0) return;
  mkdirSync(dirname(excludeFile), { recursive: true });
  const lead = existing.length > 0 && existing[existing.length - 1] !== "" ? "\n" : "";
  appendFileSync(excludeFile, `${lead}${lines.join("\n")}\n`);
}

/** The project's folders holding this skill: `<agent folder>/skills/<name>`, as the `skills` CLI lays them out. */
function skillFolders(top: string, name: string): string[] {
  return readdirSync(top)
    .filter((entry) => entry !== ".git" && entry !== "node_modules")
    .map((entry) => `${entry}/skills/${name}`)
    .filter((path) => existsSync(join(top, path)) || isLink(join(top, path)))
    .map((path) => `/${path}`);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function summary(io: MoroIo, result: { add: string[]; remove: string[]; keepOut: boolean }): number {
  if (result.add.length === 0 && result.remove.length === 0) {
    io.stdout.write("Up to date.\n");
    return 0;
  }
  if (result.add.length > 0) io.stdout.write(`Installed: ${result.add.join(", ")}.\n`);
  if (result.remove.length > 0) io.stdout.write(`Removed: ${result.remove.join(", ")}.\n`);
  const next = result.keepOut
    ? "restart your agent in this project; the skills are kept out of git."
    : `restart your agent in this project, and commit ${LOCK_FILE} and the new skill folders.`;
  io.stdout.write(`\nNext: ${next} Run \`moro install\` again to change the picks.\n`);
  return 0;
}
