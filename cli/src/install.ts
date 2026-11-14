// `moro install`: the set's skills, offered in one multi-select and copied into
// the project from the clone. Nothing is recorded in the project beyond what the
// `skills` CLI writes (its `skills-lock.json` and the skill folders).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { findClone } from "./device.js";
import { cloneCopy, diffFolders, diverge, projectCopy, needsRerun, reportLines, type Divergence, type Label, type SetSkill } from "./divergence.js";
import { gitRunner } from "./git.js";
import { RERUN_SETUP, UP_TO_DATE } from "./hints.js";
import type { MoroIo } from "./main.js";
import { readManifest } from "./manifest.js";
import { PROJECT_LOCK, readProjectLock, skillFolders } from "./project.js";
import { askYesNo, type MultiSelectRequest } from "./prompter.js";
import { localOnlySkills, LOCAL_ONLY_DIR, skillFolder, skillsWithGroups } from "./set-layout.js";
import { runSkills } from "./skills-cli.js";
import { UserError } from "./user-error.js";
import { MORO_VERSION } from "./version.js";

const USAGE = "moro install [--yes] [--pick <skill…>] [--keep-out | --commit] [--use-set-copy <skill…>]";

/** One skill the project can take; a local-only one is copied from the clone's gitignored `local-only/` and always kept out of the project's git. */
interface Offer extends SetSkill {
  recommended: boolean;
}

/** What the command line answers, so no prompt is needed for it. */
interface InstallArgs {
  /** Take each recommended answer, and push nothing: ask nothing. */
  yes: boolean;
  /** The skills the project should have, instead of the picker. */
  pick?: string[];
  /** Keep a first install's skills out of git (true) or commit them (false), instead of asking. */
  keepOut?: boolean;
  /** The edited here or loose skills that the set's copy replaces, instead of asking. */
  useSetCopy?: string[];
}

export async function install(io: MoroIo, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const { yes } = args;
  const git = gitRunner(io.env);
  const top = await projectTop(git, io.cwd);
  const clone = findClone(io);

  const offers = readOffers(clone);
  if (offers.length === 0) {
    throw new UserError(`The set at ${clone} has no skills to install.\n\nNext: add some with \`moro add\`.`);
  }
  for (const name of [...(args.pick ?? []), ...(args.useSetCopy ?? [])]) {
    if (!offers.some((offer) => offer.name === name) && !installedSkills(top).includes(name)) {
      throw new UserError(`${name} is not a skill in the set.\n\nNext: pick from the skills \`moro install\` offers.`);
    }
  }
  const current = installedSkills(top);
  const firstInstall = current.length === 0;

  const divergence = diverge(top, clone, offers, current);
  writeReport(io, divergence);
  const hasLabel = (name: string, label: Label) => !!divergence.labels.get(name)?.includes(label);

  const rules = readRules(clone, offers);
  const start = offers
    .filter((offer) => (firstInstall ? offer.recommended : current.includes(offer.name)))
    .map((offer) => offer.name);
  // `--yes` lets go of what the set no longer holds; the picker keeps it ticked until the owner unticks it.
  const chosen =
    args.pick ??
    (yes
      ? start
      : await io.prompter.multiSelect(offerChoices(offers, new Set([...start, ...divergence.gone]), lockedSkills(rules, start), divergence)));
  const { picks, reasons } = withLocked(rules, chosen);

  const planned = plan(offers, current, picks, divergence.gone);
  const remove = planned.remove;
  const add = [...planned.add];
  // Set changed skills come again from the clone; edited here and loose ones only when the owner agrees.
  const update = picks.filter((name) => current.includes(name) && hasLabel(name, "set changed") && !hasLabel(name, "edited here"));
  for (const name of picks.filter((pick) => hasLabel(pick, "edited here") || hasLabel(pick, "loose"))) {
    const offer = offers.find((candidate) => candidate.name === name)!;
    // Without an answer, `--yes` never overwrites the owner's copy.
    const useSet = args.useSetCopy ? args.useSetCopy.includes(name) : !yes && (await askUseSetCopy(io, top, clone, offer));
    if (useSet) {
      if (hasLabel(name, "edited here")) update.push(name);
    } else if (hasLabel(name, "loose")) add.splice(add.indexOf(name), 1);
  }

  let keepOut = args.keepOut ?? false;
  if (firstInstall && add.length > 0 && args.keepOut === undefined) {
    keepOut = yes || (await askKeepOut(io));
  }
  const excludeFile = (await git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], top)).trim();
  // A project that kept its skills out of git keeps the new ones out too.
  keepOut ||= !firstInstall && existsSync(excludeFile) && readFileSync(excludeFile, "utf8").split("\n").includes(`/${PROJECT_LOCK}`);

  const localAdds = add.filter((name) => offers.find((offer) => offer.name === name)?.localOnly);
  await apply(io, { clone, top, add: [...add, ...update], remove, offers });
  if (keepOut && add.length > 0) excludeFromGit(top, excludeFile, add, true);
  else if (localAdds.length > 0) excludeFromGit(top, excludeFile, localAdds, false);

  return summary(io, { add, update, remove, keepOut, reasons });
}

/** Bare `moro` in a project: the divergence report and the one next step. */
export async function projectStatus(io: MoroIo, git: ReturnType<typeof gitRunner>): Promise<number> {
  const top = await projectTop(git, io.cwd);
  const clone = findClone(io);
  const divergence = diverge(top, clone, readOffers(clone), installedSkills(top));
  writeReport(io, divergence);
  io.stdout.write(`${needsRerun(divergence) ? RERUN_SETUP : UP_TO_DATE}\n`);
  return 0;
}

function writeReport(io: MoroIo, divergence: Divergence): void {
  const lines = reportLines(divergence);
  if (lines.length > 0) io.stdout.write(`This project against the set:\n${lines.map((line) => `  ${line}`).join("\n")}\n\n`);
}

/** Shows how the project's copy differs from the clone's, then asks whether the set's copy replaces it. */
async function askUseSetCopy(io: MoroIo, top: string, clone: string, offer: Offer): Promise<boolean> {
  const mine = projectCopy(top, offer.name)!;
  io.stdout.write(`${offer.name}: the project's copy differs from the set's.\n${diffFolders(mine, cloneCopy(clone, offer))}\n`);
  return askYesNo(io.prompter, `Use the set's copy of ${offer.name}?`, "no");
}

function parseArgs(argv: string[]): InstallArgs {
  const args: InstallArgs = { yes: false };
  const names = (flag: string, from: number): string[] => {
    const found: string[] = [];
    for (let i = from; i < argv.length && !argv[i]!.startsWith("-"); i++) found.push(argv[i]!);
    if (found.length === 0) throw new UserError(`${flag} takes skill names.\n\nNext: run \`${USAGE}\``);
    return found;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--keep-out" || arg === "--commit") {
      if (args.keepOut !== undefined && args.keepOut !== (arg === "--keep-out")) {
        throw new UserError(`Give --keep-out or --commit, not both.\n\nNext: run \`${USAGE}\``);
      }
      args.keepOut = arg === "--keep-out";
    } else if (arg === "--pick" || arg === "--use-set-copy") {
      const found = names(arg, i + 1);
      i += found.length;
      if (arg === "--pick") args.pick = found;
      else args.useSetCopy = found;
    } else throw new UserError(`Unknown option: ${arg}\n\nNext: run \`${USAGE}\``);
  }
  return args;
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
  const shared = skillsWithGroups(clone).map(({ name, group }) => ({ name, group, recommended: recommended.has(name) }));
  const local = localOnlySkills(clone).map(({ name, group }) => ({ name, group, recommended: true, localOnly: true }));
  for (const offer of local) {
    const twin = shared.find((other) => other.name === offer.name);
    if (twin) {
      throw new UserError(
        `${offer.name} is in both ${skillFolder(offer.name, twin.group)} and ${join(LOCAL_ONLY_DIR, offer.group, offer.name)}, and a project installs both into one folder.\n\nNext: rename or remove one of them in the clone, then run \`moro install\` again.`,
      );
    }
  }
  return [...shared, ...local];
}

/** What the set insists on: required skills, and each skill's dependencies. */
interface Rules {
  required: string[];
  dependsOn: Record<string, string[]>;
}

/** The manifest's required and dependsOn; stops, before anything changes, on an entry the set doesn't hold. */
function readRules(clone: string, offers: Offer[]): Rules {
  const manifest = readManifest(clone, MORO_VERSION);
  const held = new Set(offers.map((offer) => offer.name));
  const heldPaths = new Set(offers.filter((offer) => !offer.localOnly).map((offer) => skillFolder(offer.name, offer.group)));
  const wrong = (entry: string, where: string): never => {
    throw new UserError(
      `manifest.json names ${entry} in ${where}, and the set doesn't hold it.\n\nNext: fix that entry in manifest.json, then run \`${USAGE}\` again.`,
    );
  };
  const required: string[] = [];
  for (const path of manifest.required ?? []) {
    if (path.startsWith(`${LOCAL_ONLY_DIR}/`)) continue;
    if (!heldPaths.has(path)) wrong(path, "required");
    required.push(basename(path));
  }
  for (const [key, needs] of Object.entries(manifest.dependsOn)) {
    if (!held.has(key)) wrong(key, "dependsOn");
    for (const need of needs) if (!held.has(need)) wrong(need, `dependsOn of ${key}`);
  }
  return { required, dependsOn: manifest.dependsOn };
}

/** Why each skill is locked on: required, or needed by a ticked skill (through any depth). */
function lockedSkills(rules: Rules, picks: string[]): Map<string, string> {
  const locked = new Map<string, string>(rules.required.map((name) => [name, "required by the set"]));
  const queue = [...rules.required, ...picks];
  for (const name of queue) {
    for (const need of rules.dependsOn[name] ?? []) {
      if (locked.has(need)) continue;
      locked.set(need, `needed by ${name}`);
      queue.push(need);
    }
  }
  return locked;
}

/** The picks plus everything locked on, and why each skill the owner didn't pick got added. */
function withLocked(rules: Rules, chosen: string[]): { picks: string[]; reasons: Map<string, string> } {
  const locked = lockedSkills(rules, chosen);
  const reasons = new Map([...locked].filter(([name]) => !chosen.includes(name)));
  return { picks: [...new Set([...chosen, ...locked.keys()])], reasons };
}

/** The skills in the project's `skills-lock.json`. */
function installedSkills(top: string): string[] {
  return Object.keys(readProjectLock(top)).sort();
}

/** Recommended skills first, then experimental ones, each under its group; `ticked` start picked. */
function offerChoices(offers: Offer[], ticked: Set<string>, locked: Map<string, string>, divergence: Divergence): MultiSelectRequest {
  const labelled = (name: string) => {
    const labels = divergence.labels.get(name);
    return labels ? `${name} (${labels.join(", ")})` : name;
  };
  const choice = (offer: Offer, section: string) => ({
    value: offer.name,
    label: labelled(offer.name),
    section,
    group: offer.group,
    picked: ticked.has(offer.name) || locked.has(offer.name),
    ...(locked.has(offer.name) ? { disabled: locked.get(offer.name)! } : {}),
  });
  return {
    message: "Which skills should this project have?",
    choices: [
      ...offers.filter((offer) => offer.recommended).map((offer) => choice(offer, "Recommended")),
      ...offers.filter((offer) => !offer.recommended).map((offer) => choice(offer, "Experimental")),
      ...divergence.gone.map((name) => ({ value: name, label: labelled(name), section: "Gone from the set", picked: ticked.has(name) })),
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
function plan(offers: Offer[], current: string[], picks: string[], gone: string[]): { add: string[]; remove: string[] } {
  const offered = new Set([...offers.map((offer) => offer.name), ...gone]);
  return {
    add: picks.filter((name) => !current.includes(name)).sort(),
    // A skill installed from somewhere else isn't the set's to remove.
    remove: current.filter((name) => offered.has(name) && !picks.includes(name)),
  };
}

async function apply(io: MoroIo, work: { clone: string; top: string; add: string[]; remove: string[]; offers: Offer[] }): Promise<void> {
  const local = work.offers.filter((offer) => offer.localOnly && work.add.includes(offer.name));
  const shared = work.add.filter((name) => !local.some((offer) => offer.name === name));
  const installs = [
    ...(shared.length > 0 ? [["add", work.clone, "-y", "--skill", ...shared]] : []),
    ...local.map((offer) => ["add", join(work.clone, LOCAL_ONLY_DIR, offer.group, offer.name), "-y"]),
  ];
  for (const args of installs) {
    const result = await runSkills(args, { env: io.env, cwd: work.top });
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
function excludeFromGit(top: string, excludeFile: string, names: string[], withLock: boolean): void {
  const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8").split("\n") : [];
  const wanted = [...(withLock ? [`/${PROJECT_LOCK}`] : []), ...names.flatMap((name) => skillFolders(top, name).map((path) => `/${path}`))];
  const lines = wanted.filter((line) => !existing.includes(line));
  if (lines.length === 0) return;
  mkdirSync(dirname(excludeFile), { recursive: true });
  const lead = existing.length > 0 && existing[existing.length - 1] !== "" ? "\n" : "";
  appendFileSync(excludeFile, `${lead}${lines.join("\n")}\n`);
}

function summary(io: MoroIo, result: { add: string[]; update: string[]; remove: string[]; keepOut: boolean; reasons: Map<string, string> }): number {
  if (result.add.length === 0 && result.update.length === 0 && result.remove.length === 0) {
    io.stdout.write(`${UP_TO_DATE}\n`);
    return 0;
  }
  if (result.add.length > 0) io.stdout.write(`Installed: ${result.add.join(", ")}.\n`);
  for (const [name, reason] of result.reasons) {
    if (result.add.includes(name)) io.stdout.write(`  ${name}: ${reason}.\n`);
  }
  if (result.update.length > 0) io.stdout.write(`Updated: ${result.update.join(", ")}.\n`);
  if (result.remove.length > 0) io.stdout.write(`Removed: ${result.remove.join(", ")}.\n`);
  const next = result.keepOut
    ? "restart your agent in this project; the skills are kept out of git."
    : `restart your agent in this project, and commit ${PROJECT_LOCK} and the new skill folders.`;
  io.stdout.write(`\nNext: ${next} Run \`moro install\` again to change the picks.\n`);
  return 0;
}
