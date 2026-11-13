// `moro add <ref> <skill…>`: intake of skills from a source into the set.
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Git, GitError, gitRunner } from "./git.js";
import { addSource, hasSkill, MANIFEST_FILE, type Manifest, readManifest, writeManifest } from "./manifest.js";
import type { MoroIo } from "./main.js";
import { cloneUrl, parseRef, type SourceRef } from "./ref.js";
import { render, renderName } from "./render.js";
import { existingSkillFolder, skillFolder } from "./set-layout.js";
import { checkout, type Checkout, findSkills, type FoundSkill, readSkillFiles } from "./source.js";
import { UserError } from "./user-error.js";
import { MORO_VERSION } from "./version.js";

interface AddArgs {
  input: string;
  ref: SourceRef;
  skills: string[];
  /** Put the skills in `work/`, so they install only on work machines. */
  work: boolean;
}

/** One skill coming in: where it is in the source, its name in the set, and its folder there. */
interface Incoming {
  skill: FoundSkill;
  name: string;
  folder: string;
}

const OPTIONS = ["--yes", "-y", "--work"];

export async function add(io: MoroIo, argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const git = gitRunner(io.env);
  const setDir = await git(["rev-parse", "--show-toplevel"], io.cwd).catch(() => {
    throw new UserError("Run moro add in the set's clone.");
  });
  await requireRepoIdentity(git, setDir);

  const source = await checkout(git, cloneUrl(args.ref.repo), args.ref.revision).catch((error: unknown) => {
    if (error instanceof GitError) throw new UserError(`Can't read ${args.input}: ${error.stderr.trim()}`);
    throw error;
  });
  try {
    const committed = await intake(git, setDir, source, args);
    io.stdout.write(
      `Added ${committed.names.join(", ")} from ${committed.sourceId} in one commit.\n\nNext: run \`git push\` in the set's clone.\n`,
    );
    return 0;
  } finally {
    source.remove();
  }
}

function parseArgs(argv: string[]): AddArgs {
  const unknown = argv.find((arg) => arg.startsWith("-") && !OPTIONS.includes(arg));
  if (unknown) throw new UserError(`Unknown option: ${unknown}\n\nNext: run moro add <ref> <skill…> [--work] [--yes]`);
  const [input, ...skills] = argv.filter((arg) => !arg.startsWith("-"));
  if (!input) throw new UserError("Name a source: moro add <ref> <skill…>");
  if (input.startsWith(".")) throw new UserError(`Give ${input} as a git URL or an absolute path, not a relative one.`);
  return { input, ref: parseRef(input), skills, work: argv.includes("--work") };
}

/** Renders the chosen skills into the set and commits them with the manifest, or changes nothing. */
async function intake(git: Git, setDir: string, source: Checkout, args: AddArgs) {
  const manifest = readManifest(setDir, MORO_VERSION);
  const sourceId = addSource(manifest, args.ref.repo);
  const rules = manifest.sources[sourceId]!.rename;
  const incoming = chooseSkills(args, findSkills(source.dir, args.ref.subpath)).map(
    (skill): Incoming => {
      const name = renderName(skill.name, rules);
      return { skill, name, folder: skillFolder(name, args.work) };
    },
  );
  checkNamesAreFree(setDir, manifest, incoming);

  const manifestBefore = existsSync(join(setDir, MANIFEST_FILE)) ? readFileSync(join(setDir, MANIFEST_FILE)) : undefined;
  const paths = [MANIFEST_FILE, ...incoming.map(({ folder }) => folder)];
  const names = incoming.map(({ name }) => name);
  try {
    for (const { skill, name, folder } of incoming) {
      for (const file of render(readSkillFiles(join(source.dir, skill.path)), rules, name)) {
        const target = join(setDir, folder, file.path);
        mkdirSync(dirname(target), { recursive: true });
        if ("symlink" in file) symlinkSync(file.symlink, target);
        else {
          writeFileSync(target, file.content);
          chmodSync(target, file.mode);
        }
      }
      manifest.skills[name] = { source: sourceId, path: skill.path, pin: source.pin, skipped: [] };
    }
    writeManifest(setDir, manifest);
    await git(["add", "--", ...paths], setDir);
    await git(["commit", "-q", "-m", `add: ${sourceId} ${names.join(" ")}`, "--", ...paths], setDir);
  } catch (error) {
    await git(["reset", "-q", "--", ...paths], setDir).catch(() => undefined);
    for (const { folder } of incoming) rmSync(join(setDir, folder), { recursive: true, force: true });
    if (manifestBefore) writeFileSync(join(setDir, MANIFEST_FILE), manifestBefore);
    else rmSync(join(setDir, MANIFEST_FILE), { force: true });
    if (error instanceof GitError) throw new UserError(`Intake changed nothing: ${error.message}`);
    throw error;
  }
  return { sourceId, names };
}

/** The skills named in the ref and on the command line, or the one skill a tree URL points at. */
function chooseSkills(args: AddArgs, found: FoundSkill[]): FoundSkill[] {
  const names = [...new Set([...(args.ref.skill ? [args.ref.skill] : []), ...args.skills])];
  if (names.length === 0) {
    if (args.ref.subpath && found.length === 1) return found;
    throw new UserError(`Name the skills to add: moro add ${args.input} <skill…>`);
  }
  return names.map((name) => {
    const skill = found.find((candidate) => candidate.name === name);
    if (!skill) throw new UserError(`${args.input} has no skill named ${name}.`);
    return skill;
  });
}

/** Names are unique across the set, and within one run. */
function checkNamesAreFree(setDir: string, manifest: Manifest, incoming: Incoming[]): void {
  incoming.forEach(({ skill, name }, index) => {
    const earlier = incoming.slice(0, index).find((other) => other.name === name);
    if (earlier) throw new UserError(`${earlier.skill.name} and ${skill.name} would both be ${name} in the set.`);
    const taken = existingSkillFolder(setDir, name) ?? (hasSkill(manifest, name) ? MANIFEST_FILE : undefined);
    if (taken) throw new UserError(`${name} is already in the set (${taken}).`);
  });
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
