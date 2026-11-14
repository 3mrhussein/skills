// `moro install`: the set's skills, offered in one multi-select and copied into
// the project from the clone. Nothing is recorded in the project beyond what the
// `skills` CLI writes (its `skills-lock.json` and the skill folders).
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { findClone, worktreeOf } from "./device.js";
import { agentsOnDisk, DEFAULT_AGENTS, missingFrom, SHARED_FOLDER } from "./agents.js";
import { cloneCopy, diffFolders, diverge, fromClone, projectCopy, needsRerun, reportLines, type Divergence, type Label, type Place, type SetSkill } from "./divergence.js";
import { readLock } from "./lock.js";
import { gitRunner } from "./git.js";
import { RERUN_INSTALL, RERUN_SETUP, UP_TO_DATE } from "./hints.js";
import { readLocations } from "./locations.js";
import type { MoroIo } from "./main.js";
import { readManifest } from "./manifest.js";
import { PROJECT_LOCK, readProjectLock, skillFolders } from "./project.js";
import { askYesNo, type MultiSelectRequest } from "./prompter.js";
import { ENTRY_SKILL, localOnlyFolder, localOnlySkills, LOCAL_ONLY_DIR, skillFolder, skillsWithGroups } from "./set-layout.js";
import { shadowedPicks } from "./shadowing.js";
import { runSkills } from "./skills-cli.js";
import { UserError } from "./user-error.js";
import { MORO_VERSION } from "./version.js";

const USAGE =
  "moro install [--user] [--yes] [--pick <skill…>] [--agents <agent…>] [--keep-out | --commit] [--use-set-copy <skill…>] [--from <worktree>]";

/** One skill the project can take; a local-only one is copied from the clone's gitignored `skills.local/` and always kept out of the project's git. */
interface Offer extends SetSkill {
  recommended: boolean;
}

/** What the command line answers, so no prompt is needed for it. */
interface InstallArgs {
  /** Take each recommended answer, and push nothing: ask nothing. */
  yes: boolean;
  /** Install at user level, for every project on the device, in place of the current project. */
  user: boolean;
  /** The skills the project should have, instead of the picker. */
  pick?: string[];
  /** The agents to install for, passed to the `skills` CLI as `-a`. */
  agents?: string[];
  /** Keep a first install's skills out of git (true) or commit them (false), instead of asking. */
  keepOut?: boolean;
  /** The edited here or loose skills that the set's copy replaces, instead of asking. */
  useSetCopy?: string[];
  /** A trial's worktree of the clone to install from, in place of the clone. */
  from?: string;
}

export async function install(io: MoroIo, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const { yes, user } = args;
  const scope = user ? "user" : "project";
  const git = gitRunner(io.env);
  const locations = readLocations(io.env);
  const top = user ? locations.home : await projectTop(git, io.cwd);
  const clone = findClone(io);
  // The shared skills and the manifest come from `setDir`; local-only skills always from the clone.
  const setDir = args.from === undefined ? clone : trialWorktree(clone, resolve(io.cwd, args.from));

  const offers = readOffers(setDir, clone);
  if (offers.length === 0) {
    throw new UserError(`The set at ${setDir} has no skills to install.\n\nNext: add some with \`moro add\`.`);
  }
  const place = user ? userPlace(locations, clone) : undefined;
  const current = place ? Object.keys(place.lock).sort() : installedSkills(top);
  for (const name of [...(args.pick ?? []), ...(args.useSetCopy ?? [])]) {
    if (!offers.some((offer) => offer.name === name) && !current.includes(name)) {
      throw new UserError(`${name} is not a skill in the set.\n\nNext: pick from the skills \`moro install\` offers.`);
    }
  }
  const firstInstall = current.length === 0;
  // In a project, a skill the set already put at user level is there for every agent: offered, but not ticked.
  const atUser = user ? new Set<string>() : new Set(Object.keys(userPlace(locations, clone).lock));

  const divergence = diverge(top, setDir, offers, current, clone, place);
  markAtUser(divergence, offers, current, atUser);
  writeReport(io, divergence, user ? "User level" : "This project");
  const hasLabel = (name: string, label: Label) => !!divergence.labels.get(name)?.includes(label);
  const copyOf = (name: string) => (place ? place.copyOf(name) : projectCopy(top, name));

  const rules = readRules(setDir, offers);
  const start = offers
    .filter((offer) => (firstInstall ? offer.recommended && !atUser.has(offer.name) : current.includes(offer.name)))
    .map((offer) => offer.name);
  // `--yes` lets go of what the set no longer holds; the picker keeps it ticked until the owner unticks it.
  const chosen =
    args.pick ??
    (yes
      ? start
      : await io.prompter.multiSelect(
          offerChoices(offers, new Set([...start, ...divergence.gone]), lockedSkills(rules, start, atUser), divergence, user),
        ));
  const { picks, reasons } = withLocked(rules, chosen, atUser);
  const agents = args.agents ?? (firstInstall ? DEFAULT_AGENTS : agentsOnDisk(top, current, scope));

  const planned = plan(offers, current, picks, divergence.gone);
  const remove = planned.remove;
  const add = [...planned.add];
  // Set changed skills come again from the clone; edited here and loose ones only when the owner agrees.
  const update = picks.filter((name) => current.includes(name) && hasLabel(name, "set changed") && !hasLabel(name, "edited here"));
  const keepMine = new Set<string>();
  for (const name of picks.filter((pick) => hasLabel(pick, "edited here") || hasLabel(pick, "loose"))) {
    const offer = offers.find((candidate) => candidate.name === name)!;
    // Without an answer, `--yes` never overwrites the owner's copy.
    const useSet = args.useSetCopy
      ? args.useSetCopy.includes(name)
      : !yes && (await askUseSetCopy(io, copyOf(name)!, cloneCopy(setDir, offer, clone), offer));
    if (useSet) {
      if (hasLabel(name, "edited here")) update.push(name);
    } else {
      keepMine.add(name);
      if (hasLabel(name, "loose")) add.splice(add.indexOf(name), 1);
    }
  }
  // An installed skill missing from a picked agent's folder is added again, so every agent sees it.
  for (const name of missingFrom(top, agents, picks.filter((pick) => current.includes(pick)), scope).keys()) {
    if (!update.includes(name) && !keepMine.has(name) && !remove.includes(name)) update.push(name);
  }

  let keepOut = args.keepOut ?? false;
  let excludeFile = "";
  if (!user) {
    if (firstInstall && add.length > 0 && args.keepOut === undefined) {
      keepOut = yes || (await askKeepOut(io));
    }
    excludeFile = (await git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], top)).trim();
    // A project that kept its skills out of git keeps the new ones out too.
    keepOut ||= !firstInstall && existsSync(excludeFile) && readFileSync(excludeFile, "utf8").split("\n").includes(`/${PROJECT_LOCK}`);
  }

  const output = await apply(io, { setDir, clone, top, add: [...add, ...update], remove, offers, agents, user });
  const missing = missingFrom(top, agents, [...add, ...update], scope);
  const landed = (name: string) => !missing.has(name);
  const added = add.filter(landed);
  if (!user) {
    const localAdds = added.filter((name) => offers.find((offer) => offer.name === name)?.localOnly);
    // Every installed pick, so a folder a rerun linked for a new agent stays out of git too.
    if (keepOut) excludeFromGit(top, excludeFile, picks.filter((name) => landed(name) && !remove.includes(name) && existsSync(join(top, SHARED_FOLDER, name))), true);
    else if (localAdds.length > 0) excludeFromGit(top, excludeFile, localAdds, false);
  }

  return summary(io, {
    add: added,
    update: update.filter((name) => landed(name) && !added.includes(name)),
    remove,
    keepOut,
    reasons,
    agents,
    user,
    missing: [...missing].map(([name, without]) => `${name} (${without.join(", ")})${skipReason(output, name)}`),
    shadowed: user ? [] : shadowedPicks(locations, clone, picks),
    alsoAtUser: picks.filter((name) => atUser.has(name)),
  });
}

/** User level's skills from the clone: the `skills` CLI's user-level lock, and the copies in `~/.agents/skills`. */
function userPlace(locations: ReturnType<typeof readLocations>, clone: string): Place {
  const lock: Place["lock"] = {};
  for (const [name, entry] of Object.entries(readLock(locations.lockFile))) {
    if (name === ENTRY_SKILL || ![clone, `${clone}-try`].some((root) => fromClone(locations.home, root, entry.source))) continue;
    lock[name] = { source: entry.source, computedHash: entry.skillFolderHash };
  }
  return {
    lock,
    copyOf: (name) => {
      const folder = join(locations.home, SHARED_FOLDER, name);
      return existsSync(folder) && statSync(folder).isDirectory() ? folder : undefined;
    },
  };
}

/** Labels the skills the set put at user level, which a project needn't install again. */
function markAtUser(divergence: Divergence, offers: Offer[], current: string[], atUser: Set<string>): void {
  for (const offer of offers) {
    if (!atUser.has(offer.name) || current.includes(offer.name)) continue;
    const labels = (divergence.labels.get(offer.name) ?? []).filter((label) => label !== "not installed");
    divergence.labels.set(offer.name, [...labels, "installed (user)"]);
  }
}

/** The `skills` CLI's own reason for skipping a skill, as `: <reason>`, when its output gives one. */
function skipReason(output: string, name: string): string {
  const line = output.split("\n").find((text) => text.includes("Skipped") && text.includes(`/${name}/SKILL.md`));
  const reason = line?.split(" — ")[1]?.trim();
  return reason ? `: ${reason}` : "";
}

/** Bare `moro` in a project: the divergence report and the one next step. */
export async function projectStatus(io: MoroIo, git: ReturnType<typeof gitRunner>): Promise<number> {
  const top = await projectTop(git, io.cwd);
  const clone = findClone(io);
  const divergence = diverge(top, clone, readOffers(clone, clone), installedSkills(top));
  writeReport(io, divergence);
  io.stdout.write(`${needsRerun(divergence) ? RERUN_SETUP : UP_TO_DATE}\n`);
  return 0;
}

function writeReport(io: MoroIo, divergence: Divergence, where = "This project"): void {
  const lines = reportLines(divergence);
  if (lines.length > 0) io.stdout.write(`${where} against the set:\n${lines.map((line) => `  ${line}`).join("\n")}\n\n`);
}

/** User level against the set, for bare \`moro\` outside a project: the report's lines, and whether \`moro install --user\` would change anything. */
export function userLevelReport(io: MoroIo): { lines: string[]; rerun: boolean } {
  const locations = readLocations(io.env);
  const clone = findClone(io);
  const place = userPlace(locations, clone);
  const current = Object.keys(place.lock).sort();
  if (current.length === 0) return { lines: [], rerun: false };
  const divergence = diverge(locations.home, clone, readOffers(clone, clone), current, clone, place);
  return { lines: reportLines(divergence), rerun: needsRerun(divergence) };
}

/** Shows how the project's copy differs from the clone's, then asks whether the set's copy replaces it. */
async function askUseSetCopy(io: MoroIo, mine: string, setCopy: string, offer: Offer): Promise<boolean> {
  io.stdout.write(`${offer.name}: this copy differs from the set's.\n${diffFolders(mine, setCopy)}\n`);
  return askYesNo(io.prompter, `Use the set's copy of ${offer.name}?`, "no");
}

function parseArgs(argv: string[]): InstallArgs {
  const args: InstallArgs = { yes: false, user: false };
  const names = (flag: string, from: number): string[] => {
    const found: string[] = [];
    for (let i = from; i < argv.length && !argv[i]!.startsWith("-"); i++) found.push(argv[i]!);
    if (found.length === 0) throw new UserError(`${flag} takes skill names.\n\nNext: run \`${USAGE}\``);
    return found;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--yes" || arg === "-y") args.yes = true;
    else if (arg === "--user") args.user = true;
    else if (arg === "--keep-out" || arg === "--commit") {
      if (args.keepOut !== undefined && args.keepOut !== (arg === "--keep-out")) {
        throw new UserError(`Give --keep-out or --commit, not both.\n\nNext: run \`${USAGE}\``);
      }
      args.keepOut = arg === "--keep-out";
    } else if (arg === "--from") {
      const folder = argv[++i];
      if (!folder || folder.startsWith("-")) throw new UserError(`--from takes a worktree of the set's clone.\n\nNext: run \`${USAGE}\``);
      args.from = folder;
    } else if (arg === "--pick" || arg === "--use-set-copy" || arg === "--agents") {
      const found = names(arg, i + 1);
      i += found.length;
      if (arg === "--pick") args.pick = found;
      else if (arg === "--agents") args.agents = found;
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

/** `--from`'s folder, when it is the clone or a worktree of it: a trial's candidate. */
function trialWorktree(clone: string, folder: string): string {
  const real = existsSync(folder) ? realpathSync(folder) : folder;
  if (real === realpathSync(clone)) return clone;
  const worktree = existsSync(folder) ? worktreeOf(clone, folder) : undefined;
  if (worktree === real) return worktree;
  throw new UserError(
    `${folder} isn't a worktree of the set's clone (${clone}).\n\nNext: run \`moro try <skill>\` in the set's clone, then pass one of the worktrees it prints.`,
  );
}

function readOffers(setDir: string, clone: string): Offer[] {
  const manifest = readManifest(setDir, MORO_VERSION);
  const recommended = new Set(manifest.recommended.map((path) => basename(path)));
  // The entry skill lives at user level, so a project install never offers it.
  const shared = skillsWithGroups(setDir).filter(({ name }) => name !== ENTRY_SKILL).map(({ name, group }) => ({ name, group, recommended: recommended.has(name) }));
  const local = localOnlySkills(clone).map(({ name, group }) => ({ name, group, recommended: true, localOnly: true }));
  for (const offer of local) {
    const twin = shared.find((other) => other.name === offer.name);
    if (twin) {
      throw new UserError(
        `${offer.name} is in both ${skillFolder(offer.name, twin.group)} and ${localOnlyFolder(offer.name)}, and a project installs both into one folder.\n\nNext: rename or remove one of them in the clone, then run \`moro install\` again.`,
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
  // The entry skill is already at user level, so a project never installs it, required or needed.
  for (const path of manifest.required ?? []) {
    if (path.startsWith(`${LOCAL_ONLY_DIR}/`) || basename(path) === ENTRY_SKILL) continue;
    if (!heldPaths.has(path)) wrong(path, "required");
    required.push(basename(path));
  }
  const dependsOn: Record<string, string[]> = {};
  for (const [key, needs] of Object.entries(manifest.dependsOn)) {
    if (key === ENTRY_SKILL) continue;
    if (!held.has(key)) wrong(key, "dependsOn");
    dependsOn[key] = needs.filter((need) => need !== ENTRY_SKILL);
    for (const need of dependsOn[key]) if (!held.has(need)) wrong(need, `dependsOn of ${key}`);
  }
  return { required, dependsOn };
}

/** Why each skill is locked on: required, or needed by a ticked skill (through any depth). One already at user level is never locked on. */
function lockedSkills(rules: Rules, picks: string[], atUser = new Set<string>()): Map<string, string> {
  const locked = new Map<string, string>(rules.required.map((name) => [name, "required by the set"]));
  const queue = [...rules.required, ...picks];
  for (const name of queue) {
    for (const need of rules.dependsOn[name] ?? []) {
      if (locked.has(need)) continue;
      locked.set(need, `needed by ${name}`);
      queue.push(need);
    }
  }
  for (const name of atUser) if (!picks.includes(name)) locked.delete(name);
  return locked;
}

/** The picks plus everything locked on, and why each skill the owner didn't pick got added. */
function withLocked(rules: Rules, chosen: string[], atUser = new Set<string>()): { picks: string[]; reasons: Map<string, string> } {
  const locked = lockedSkills(rules, chosen, atUser);
  const reasons = new Map([...locked].filter(([name]) => !chosen.includes(name)));
  return { picks: [...new Set([...chosen, ...locked.keys()])], reasons };
}

/** The skills in the project's `skills-lock.json`. */
function installedSkills(top: string): string[] {
  return Object.keys(readProjectLock(top)).sort();
}

/** Recommended skills first, then experimental ones, each under its group; `ticked` start picked. */
function offerChoices(offers: Offer[], ticked: Set<string>, locked: Map<string, string>, divergence: Divergence, user = false): MultiSelectRequest {
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
    message: user ? "Which skills should user level have?" : "Which skills should this project have?",
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

/** Runs the `skills` CLI's adds and removes, naming the agents; returns what it printed. */
async function apply(
  io: MoroIo,
  work: { setDir: string; clone: string; top: string; add: string[]; remove: string[]; offers: Offer[]; agents: string[]; user: boolean },
): Promise<string> {
  const local = work.offers.filter((offer) => offer.localOnly && work.add.includes(offer.name));
  const shared = work.add.filter((name) => !local.some((offer) => offer.name === name));
  const scope = work.user ? ["-g"] : [];
  const flags = [...scope, "-y", "-a", ...work.agents];
  const installs = [
    ...(shared.length > 0 ? [["add", work.setDir, ...flags, "--skill", ...shared]] : []),
    ...local.map((offer) => ["add", join(work.clone, localOnlyFolder(offer.name)), ...flags]),
  ];
  let output = "";
  for (const args of installs) {
    const result = await runSkills(args, { env: io.env, cwd: work.top });
    output += result.output;
    if (result.code !== 0) {
      throw new UserError(`Installing the skills failed, so nothing was installed.\n\n${result.output.trim()}\n\nNext: fix that, then run \`moro install\` again.`);
    }
  }
  if (work.remove.length > 0) {
    const result = await runSkills(["remove", ...scope, "-y", ...work.remove], { env: io.env, cwd: work.top });
    if (result.code !== 0) {
      throw new UserError(`Removing the skills failed.\n\n${result.output.trim()}\n\nNext: fix that, then run \`moro install\` again.`);
    }
  }
  return output;
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

function summary(
  io: MoroIo,
  result: {
    add: string[];
    update: string[];
    remove: string[];
    keepOut: boolean;
    reasons: Map<string, string>;
    shadowed: string[];
    agents: string[];
    user: boolean;
    missing: string[];
    alsoAtUser?: string[];
  },
): number {
  const changed = result.add.length > 0 || result.update.length > 0 || result.remove.length > 0;
  if (result.add.length > 0) io.stdout.write(`Installed: ${result.add.join(", ")}.\n`);
  for (const [name, reason] of result.reasons) {
    if (result.add.includes(name)) io.stdout.write(`  ${name}: ${reason}.\n`);
  }
  if (result.update.length > 0) io.stdout.write(`Updated: ${result.update.join(", ")}.\n`);
  if (result.remove.length > 0) io.stdout.write(`Removed: ${result.remove.join(", ")}.\n`);
  if (changed) io.stdout.write(`Agents: ${result.agents.join(", ")}.\n`);
  if (result.missing.length > 0) {
    io.stdout.write(`${changed ? "\n" : ""}Not installed: ${result.missing.join("; ")}.\n`);
  }
  if (result.alsoAtUser && result.alsoAtUser.length > 0) {
    io.stdout.write(
      `${changed || result.missing.length > 0 ? "\n" : ""}Also at user level: ${result.alsoAtUser.join(", ")}. Your agent loads the user-level copies; untick them here to rely on user level alone.\n`,
    );
  }
  if (result.user) {
    io.stdout.write(
      changed
        ? "\nNext: restart your agents; the skills are at user level. Rerun `moro install --user` to change the picks.\n"
        : `${UP_TO_DATE}\n`,
    );
    return 0;
  }
  const restart = result.keepOut
    ? "restart your agent in this project; the skills are kept out of git."
    : `restart your agent in this project, and commit ${PROJECT_LOCK} and the new skill folders.`;
  const picks = `Rerun \`/${ENTRY_SKILL}\` (or \`moro install\`) to change the picks.`;
  // A shadowed pick makes retiring the user-level copy the one next step.
  if (result.shadowed.length > 0) {
    const copies = result.shadowed.length === 1 ? "copy" : "copies";
    const then = changed ? ` Once it's gone, ${restart}` : "";
    io.stdout.write(
      `${changed ? "\n" : ""}Shadowed at user level: ${result.shadowed.join(", ")}. Your agent loads the user-level ${copies}, not this project's.${then}\n${RERUN_INSTALL}\n`,
    );
  } else if (changed) io.stdout.write(`\nNext: ${restart} ${picks}\n`);
  else io.stdout.write(`${UP_TO_DATE}\n`);
  return 0;
}
