// `moro add <ref> [skill…]`: intake of skills from a source into the set,
// with prompts, or with none under `--yes`.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Git, GitError, gitRunner } from "./git.js";
import {
  addSource,
  hasSkill,
  keyFor,
  MANIFEST_FILE,
  type Manifest,
  readManifest,
  type RenameRule,
  writeManifest,
} from "./manifest.js";
import type { MoroIo } from "./main.js";
import type { Prompter } from "./prompter.js";
import { cloneUrl, parseRef, type SourceRef } from "./ref.js";
import { render, renderName } from "./render.js";
import { existingSkillFolder, skillFolder } from "./set-layout.js";
import { checkout, type Checkout, findSkills, type FoundSkill, readSkillFiles, UnknownRevisionError } from "./source.js";
import { UserError } from "./user-error.js";
import { MORO_VERSION } from "./version.js";

interface AddArgs {
  input: string;
  ref: SourceRef;
  skills: string[];
  /** Put the skills in `work/`, so they install only on work machines. */
  work: boolean;
  /** Take every skill in the source that isn't in the set yet. */
  all: boolean;
  /** Ask nothing: take each default, and push. */
  yes: boolean;
}

/** A skill from the source and its name in the set. */
interface Keyed {
  skill: FoundSkill;
  name: string;
}

/** One skill coming in: where it is in the source, its name in the set, and its folder there. */
interface Incoming extends Keyed {
  folder: string;
}

/** What one add run does to the set. */
interface Plan {
  sourceId: string;
  incoming: Incoming[];
  /** Rules added to the source's rename rules, to give a clashing newcomer another key. */
  rules: RenameRule[];
  /** Set skills a newcomer of the same name takes the place of. */
  replaced: { name: string; folder?: string }[];
}

/** Where a name is already used in the set, and the folder holding it, if any. */
interface Taken {
  where: string;
  folder?: string;
}

const OPTIONS = ["--yes", "-y", "--work", "--all"];
const USAGE = "moro add <ref> [skill…] [--all] [--work] [--yes]";
/** The `skills` CLI's skill names: lowercase words joined by single hyphens. */
const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NOTHING_ADDED = "Nothing was added.";

export async function add(io: MoroIo, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const git = gitRunner(io.env);
  const setDir = await git(["rev-parse", "--show-toplevel"], io.cwd).catch(() => {
    throw new UserError("Run moro add in the set's clone.");
  });
  await requireRepoIdentity(git, setDir);

  const source = await checkoutSource(git, args);
  try {
    const manifest = readManifest(setDir, MORO_VERSION);
    const sourceId = addSource(manifest, args.ref.repo);
    const chosen = await chooseSkills(io.prompter, args, findSkills(source.dir, args.ref.subpath), (skill) =>
      keyFor(manifest, sourceId, skill.path),
    );
    if (chosen.length === 0 && args.all) {
      io.stdout.write(
        `${NOTHING_ADDED} Every skill in ${args.input} is already in the set.\n\nNext: run \`moro sync\` to take their upstream changes.\n`,
      );
      return 0;
    }
    const plan = args.yes
      ? planWithoutPrompts(setDir, manifest, sourceId, chosen, args.work)
      : await planWithPrompts(io, git, setDir, manifest, sourceId, chosen, args.work);
    if (plan.incoming.length === 0) {
      io.stdout.write(`${NOTHING_ADDED}\n\nNext: run \`moro add ${args.input}\` to pick again.\n`);
      return 0;
    }
    const othersInSet = Object.keys(manifest.skills).filter(
      (key) => manifest.skills[key]!.source === sourceId && !plan.incoming.some(({ name }) => name === key),
    );
    await intake(git, setDir, source, manifest, plan);
    io.stdout.write(`${summary(plan, othersInSet).join("\n")}\n`);
    return await offerPush(io, git, setDir, args.yes);
  } finally {
    source.remove();
  }
}

function parseArgs(argv: string[]): AddArgs {
  const unknown = argv.find((arg) => arg.startsWith("-") && !OPTIONS.includes(arg));
  if (unknown) throw new UserError(`Unknown option: ${unknown}\n\nNext: run ${USAGE}`);
  const [input, ...skills] = argv.filter((arg) => !arg.startsWith("-"));
  if (!input) throw new UserError(`Name a source: ${USAGE}`);
  if (input.startsWith(".")) throw new UserError(`Give ${input} as a git URL or an absolute path, not a relative one.`);
  const yes = argv.includes("--yes") || argv.includes("-y");
  return { input, ref: parseRef(input), skills, work: argv.includes("--work"), all: argv.includes("--all"), yes };
}

async function checkoutSource(git: Git, args: AddArgs): Promise<Checkout> {
  return checkout(git, cloneUrl(args.ref.repo), args.ref.revision).catch((error: unknown) => {
    if (error instanceof UnknownRevisionError) {
      throw new UserError(`${args.ref.repo} has no branch, tag or commit named ${error.revision}.\n\n${NOTHING_ADDED}`);
    }
    if (error instanceof GitError) {
      throw new UserError(
        [
          `Can't reach ${args.input}: ${error.stderr.trim()}`,
          "",
          `${NOTHING_ADDED} Next: check the ref, and that this machine can read the repo, then rerun.`,
        ].join("\n"),
      );
    }
    throw error;
  });
}

/**
 * The skills named in the ref and on the command line, the one skill a tree URL
 * points at, every new one under `--all`, or else the owner's picks.
 */
async function chooseSkills(
  prompter: Prompter,
  args: AddArgs,
  found: FoundSkill[],
  inSet: (skill: FoundSkill) => string | undefined,
): Promise<FoundSkill[]> {
  if (found.length === 0) throw new UserError(`${args.input} has no skills.\n\n${NOTHING_ADDED}`);
  const names = [...new Set([...(args.ref.skill ? [args.ref.skill] : []), ...args.skills])];
  if (args.all) {
    if (names.length > 0) throw new UserError(`Name skills or pass --all, not both.\n\nNext: run ${USAGE}`);
    return found.filter((skill) => !inSet(skill));
  }
  if (names.length > 0) {
    return names.map((name) => {
      const skill = found.find((candidate) => candidate.name === name);
      if (!skill) {
        throw new UserError(
          `${args.input} has no skill named ${name}.\n\n${NOTHING_ADDED} Next: run \`moro add ${args.input}\` to pick from its skills.`,
        );
      }
      return skill;
    });
  }
  if (args.ref.subpath && found.length === 1) return found;
  if (args.yes) throw new UserError(`Name the skills to add: moro add ${args.input} <skill…>, or pass --all.`);

  const listed = [...found].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const picked = await prompter.multiSelect({
    message: `Which skills from ${args.input}?`,
    choices: listed.map((skill) => {
      const key = inSet(skill);
      return { value: skill.path, label: skill.name, ...(key ? { disabled: `already in the set as ${key}` } : {}) };
    }),
  });
  return listed.filter((skill) => picked.includes(skill.path));
}

/** Every skill under its rendered name, with any clash stopping the run. */
function planWithoutPrompts(
  setDir: string,
  manifest: Manifest,
  sourceId: string,
  chosen: FoundSkill[],
  work: boolean,
): Plan {
  const rules = manifest.sources[sourceId]!.rename;
  const plan: Plan = { sourceId, incoming: [], rules: [], replaced: [] };
  for (const skill of chosen) {
    const name = renderName(skill.name, rules);
    const earlier = takenInRun(plan.incoming, name);
    if (earlier) throw clash(`${earlier.skill.name} and ${skill.name} would both be ${name} in the set.`);
    const taken = takenInSet(setDir, manifest, plan, name);
    if (taken) throw clash(`${name} is already in the set (${taken.where}).`);
    plan.incoming.push({ skill, name, folder: skillFolder(name, work) });
  }
  return plan;
}

function clash(message: string): UserError {
  return new UserError(`${message}\n\n${NOTHING_ADDED} Next: rerun without --yes to resolve the clash.`);
}

/**
 * Asks the keys (each one, or every skill's own name), resolves clashes with
 * the set, then asks once whether the skills are work unless `--work` was given.
 */
async function planWithPrompts(
  io: MoroIo,
  git: Git,
  setDir: string,
  manifest: Manifest,
  sourceId: string,
  chosen: FoundSkill[],
  workFlag: boolean,
): Promise<Plan> {
  const { prompter } = io;
  const say = (text: string) => io.stdout.write(`${text}\n`);
  // Rules added here apply to the rest of the run, and are written with the manifest.
  const rules = manifest.sources[sourceId]!.rename;
  const plan: Plan = { sourceId, incoming: [], rules: [], replaced: [] };
  const keyed: Keyed[] = [];
  const takenInThisRun = (key: string) => {
    const earlier = takenInRun(keyed, key);
    return earlier && `${key} is taken by ${earlier.skill.path} in this run. Pick another key.`;
  };
  const askEach = chosen.length <= 1 || (await askKeyMode(prompter, chosen.length)) === "each";

  for (const skill of chosen) {
    const rendered = renderName(skill.name, rules);
    const clashInRun = askEach ? undefined : takenInThisRun(rendered);
    if (clashInRun) say(clashInRun);
    let name =
      askEach || clashInRun
        ? await askKey(prompter, say, `Key for ${skill.name} in the set?`, rendered, takenInThisRun)
        : rendered;

    const taken = takenInSet(setDir, manifest, plan, name);
    if (taken) {
      const answer = await prompter.select({
        message: `${name} is already in the set (${taken.where}). Keep which?`,
        choices: [
          { value: "keep", label: `Keep the set's ${name}, and don't add ${sourceId}'s` },
          { value: "replace", label: `Take ${sourceId}'s ${name} in place of the set's` },
          { value: "rename", label: `Take ${sourceId}'s under another key, with a rename rule on ${sourceId}` },
        ],
        recommended: "keep",
      });
      const resolution = "value" in answer ? answer.value : "keep";
      if (resolution === "keep") continue;
      if (resolution === "replace") {
        if (taken.folder) await requireCommitted(git, setDir, taken.folder);
        plan.replaced.push({ name, ...(taken.folder ? { folder: taken.folder } : {}) });
        delete manifest.skills[name];
      } else {
        const original = name;
        name = await askKey(prompter, say, `Key for ${sourceId}'s ${skill.name} in the set?`, `${sourceId}-${original}`, (key) => {
          const inSet = takenInSet(setDir, manifest, plan, key);
          return takenInThisRun(key) ?? (inSet && `${key} is already in the set (${inSet.where}). Pick another key.`);
        });
        // The source's text names the skill as rendered; the rule carries that to the new key.
        if (rendered !== name) {
          const rule: RenameRule = [rendered, name];
          rules.push(rule);
          plan.rules.push(rule);
        }
      }
    }
    keyed.push({ skill, name });
  }

  if (keyed.length === 0) return plan;
  const names = keyed.map(({ name }) => name);
  const work =
    workFlag ||
    (await askYesNo(
      prompter,
      names.length === 1
        ? `Is ${names[0]} a work skill, installed only on work machines?`
        : `Are ${names.length <= 5 ? names.join(", ") : `these ${names.length} skills`} work skills, installed only on work machines?`,
      "no",
    ));
  plan.incoming = keyed.map(({ skill, name }) => ({ skill, name, folder: skillFolder(name, work) }));
  return plan;
}

async function askKeyMode(prompter: Prompter, count: number): Promise<string> {
  const answer = await prompter.select({
    message: `Keys in the set for these ${count} skills?`,
    choices: [
      { value: "names", label: "Each skill's own name" },
      { value: "each", label: "Choose each key" },
    ],
    recommended: "names",
  });
  return "value" in answer ? answer.value : "names";
}

/** A key from a prompt led by `suggested`, asked again until it is a valid name that `problem` accepts. */
async function askKey(
  prompter: Prompter,
  say: (text: string) => void,
  message: string,
  suggested: string,
  problem: (key: string) => string | undefined,
): Promise<string> {
  for (;;) {
    const answer = await prompter.select({
      message,
      choices: [{ value: suggested, label: suggested }],
      recommended: suggested,
      allowTyped: "another key",
    });
    const key = "value" in answer ? answer.value : answer.typed;
    const why = KEY.test(key) && key.length <= 64 ? problem(key) : `${key} can't be a key: use lowercase letters, digits and hyphens.`;
    if (!why) return key;
    say(why);
  }
}

async function askYesNo(prompter: Prompter, message: string, recommended: "yes" | "no"): Promise<boolean> {
  const answer = await prompter.select({
    message,
    choices: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    recommended,
  });
  return "value" in answer && answer.value === "yes";
}

function takenInRun(keyed: Keyed[], name: string): Keyed | undefined {
  return keyed.find((other) => other.name === name);
}

/** Names are unique across `skills/`, `work/` and the manifest, except for a skill this run replaces. */
function takenInSet(setDir: string, manifest: Manifest, plan: Plan, name: string): Taken | undefined {
  if (plan.replaced.some((replaced) => replaced.name === name)) return undefined;
  const folder = existingSkillFolder(setDir, name);
  if (folder) return { where: folder, folder };
  return hasSkill(manifest, name) ? { where: MANIFEST_FILE } : undefined;
}

/** A skill is replaced only when the clone holds nothing of it that isn't committed. */
async function requireCommitted(git: Git, setDir: string, folder: string): Promise<void> {
  if ((await git(["status", "--porcelain", "--", folder], setDir)) === "") return;
  throw new UserError(
    `${folder} has uncommitted changes, so it can't be replaced.\n\n${NOTHING_ADDED} Next: commit or discard them, then rerun.`,
  );
}

/** Renders the plan into the set and commits it with the manifest, or changes nothing. */
async function intake(git: Git, setDir: string, source: Checkout, manifest: Manifest, plan: Plan): Promise<void> {
  const rules = manifest.sources[plan.sourceId]!.rename;
  const manifestBefore = existsSync(join(setDir, MANIFEST_FILE)) ? readFileSync(join(setDir, MANIFEST_FILE)) : undefined;
  const replacedFolders = plan.replaced.flatMap(({ folder }) => (folder ? [folder] : []));
  const paths = [...new Set([MANIFEST_FILE, ...replacedFolders, ...plan.incoming.map(({ folder }) => folder)])];
  const names = plan.incoming.map(({ name }) => name);
  try {
    for (const folder of replacedFolders) rmSync(join(setDir, folder), { recursive: true, force: true });
    for (const { skill, name, folder } of plan.incoming) {
      for (const file of render(readSkillFiles(join(source.dir, skill.path)), rules, name)) {
        const target = join(setDir, folder, file.path);
        mkdirSync(dirname(target), { recursive: true });
        if ("symlink" in file) symlinkSync(file.symlink, target);
        else {
          writeFileSync(target, file.content);
          chmodSync(target, file.mode);
        }
      }
      manifest.skills[name] = { source: plan.sourceId, path: skill.path, pin: source.pin, skipped: [] };
    }
    writeManifest(setDir, manifest);
    await git(["add", "-A", "--", ...paths], setDir);
    await git(["commit", "-q", "-m", `add: ${plan.sourceId} ${names.join(" ")}`, "--", ...paths], setDir);
  } catch (error) {
    await git(["reset", "-q", "--", ...paths], setDir).catch(() => undefined);
    for (const { folder } of plan.incoming) rmSync(join(setDir, folder), { recursive: true, force: true });
    for (const folder of replacedFolders) await git(["checkout", "-q", "HEAD", "--", folder], setDir).catch(() => undefined);
    if (manifestBefore) writeFileSync(join(setDir, MANIFEST_FILE), manifestBefore);
    else rmSync(join(setDir, MANIFEST_FILE), { force: true });
    if (error instanceof GitError) throw new UserError(`Intake changed nothing: ${error.message}`);
    throw error;
  }
}

/** What the run did; `othersInSet` are the source's skills already in the set before it. */
function summary(plan: Plan, othersInSet: string[]): string[] {
  return [
    `Added ${plan.incoming.map(({ name }) => name).join(", ")} from ${plan.sourceId} in one commit.`,
    ...plan.replaced.map(({ name }) => `Replaced the set's ${name}.`),
    ...plan.rules.map(([from, to]) => `Rename rule on ${plan.sourceId}: ${from} → ${to}.`),
    ...(plan.rules.length > 0 && othersInSet.length > 0
      ? [`Not re-rendered with the new rule until a sync: ${othersInSet.join(", ")}.`]
      : []),
  ];
}

/** Pushes the set's clone, asking first unless `--yes`; ends with the next step. */
async function offerPush(io: MoroIo, git: Git, setDir: string, yes: boolean): Promise<number> {
  if (!yes && !(await askYesNo(io.prompter, "Push now?", "yes"))) {
    io.stdout.write("Not pushed: no machine sees this until you push.\n\nNext: run `git push` in the set's clone.\n");
    return 0;
  }
  try {
    await git(["push", "-q"], setDir);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    io.stderr.write(
      [
        `The push failed: ${error.stderr.trim()}`,
        "",
        "The commit is in the set's clone. Next: run `git pull --rebase` and `git push` in the set's clone.",
        "",
      ].join("\n"),
    );
    return 1;
  }
  io.stdout.write("Pushed.\n\nNext: run `moro refresh` on each machine that should have them.\n");
  return 0;
}

/** Commits in the set use the clone's own identity, never the machine's global one. */
async function requireRepoIdentity(git: Git, setDir: string): Promise<void> {
  const local = (key: string) => git(["config", "--local", key], setDir).catch(() => "");
  if ((await local("user.name")) && (await local("user.email"))) return;
  throw new UserError(
    [
      "The set's clone has no git identity of its own, so a commit would use this machine's global one.",
      "Next: in the set's clone, run",
      '  git config user.name "<your personal name>"',
      '  git config user.email "<your personal email>"',
    ].join("\n"),
  );
}
