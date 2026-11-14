// `moro bootstrap`: run from the set's clone. Records the clone in the device
// file and puts `setup-moro-skills` at user level, installed from the clone.
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { readDevice, writeDevice } from "./device.js";
import { gitRunner } from "./git.js";
import { requireNewEnoughMoro } from "./hints.js";
import { isFrom, type LockEntry, readLock } from "./lock.js";
import { type Locations, readLocations } from "./locations.js";
import type { MoroIo } from "./main.js";
import { askYesNo } from "./prompter.js";
import { SKILLS_DIR, skillsWithGroups, skillFolder } from "./set-layout.js";
import { isLink } from "./project.js";
import { runSkills } from "./skills-cli.js";
import { UserError } from "./user-error.js";

const SKILL = "setup-moro-skills";
const USAGE = "moro bootstrap";
/** The Claude app's own synced skills, in `~/.claude/skills`: not the owner's to retire. */
const SYNCED_DIR = "synced";

export async function bootstrap(io: MoroIo, argv: string[]): Promise<number> {
  const yes = argv.includes("--yes") || argv.includes("-y");
  const [arg] = argv.filter((a) => a !== "--yes" && a !== "-y");
  if (arg !== undefined) {
    throw new UserError(`${arg.startsWith("-") ? `Unknown option: ${arg}` : `moro bootstrap takes no ${arg}.`}\n\nNext: run \`${USAGE}\` in the set's clone`);
  }
  const locations = readLocations(io.env);
  const say = (text: string) => io.stdout.write(`${text}\n`);
  const { clone, group } = await cloneHere(io);
  requireNewEnoughMoro(clone);

  // Explore.
  const lock = readLock(locations.lockFile);
  const recorded = readDevice(locations.deviceFile)?.clone === clone;
  const installed = lock[SKILL];
  const current =
    installed !== undefined &&
    isFrom(installed, clone) &&
    sameFiles(join(clone, skillFolder(SKILL, group)), join(locations.home, ".agents", "skills", SKILL));
  say(stateParagraph(lock, clone));

  const retired = await retireOthers(io, locations, lock, yes, say);

  // The device file is written first, so a failed install leaves it for the rerun.
  if (!recorded) writeDevice(locations.deviceFile, { clone });
  if (!current) {
    const result = await runSkills(["add", clone, "-g", "-y", "--skill", SKILL], { env: io.env, cwd: locations.home });
    if (result.code !== 0) {
      throw new UserError(`Installing ${SKILL} failed:\n${result.output.trim()}\n\nNext: rerun \`${USAGE}\` in the set's clone.`);
    }
  }

  const lines = [
    ...(recorded ? [] : ["Recorded the clone."]),
    ...(retired.removed.length > 0 ? [`Removed: ${retired.removed.join(", ")}.`] : []),
    ...(current ? [] : [`${installed ? "Reinstalled" : "Installed"}: ${SKILL}.`]),
  ];
  say(`\n${lines.length > 0 ? `${lines.join("\n")}\n\nNext: open a project and run \`/setup-moro-skills\`` : "Up to date."}`);
  return 0;
}

interface Retirement {
  removed: string[];
}

/**
 * Leaves user level holding only `setup-moro-skills`, so nothing shadows a project's copy.
 * Lists the lock's other entries and the loose folders, asks once, snapshots, then removes.
 */
async function retireOthers(
  io: MoroIo,
  locations: Locations,
  lock: Record<string, LockEntry>,
  yes: boolean,
  say: (text: string) => void,
): Promise<Retirement> {
  const skillsDir = join(locations.home, ".agents", "skills");
  const linksDir = join(locations.home, ".claude", "skills");
  const locked = Object.keys(lock).filter((name) => name !== SKILL);
  const loose = [...new Set([...entries(skillsDir), ...entries(linksDir)])].filter((name) => name !== SKILL && name !== SYNCED_DIR && !(name in lock));
  const others = [...locked, ...loose].sort();
  if (others.length === 0) return { removed: [] };

  say(`\nOther user-level skills: ${listed(others)}.`);
  if (!yes && !(await askYesNo(io.prompter, "Remove them, so nothing shadows a project's install? A snapshot is taken first.", "yes"))) {
    say(`Kept: ${listed(others)}. Each one shadows a project's install of a skill with the same name.`);
    return { removed: [] };
  }

  const archive = await snapshot(locations, [skillsDir, linksDir, locations.lockFile]);
  say(`Snapshot: ${archive}\nTo restore by hand: tar -xzf ${archive} -C /`);
  if (locked.length > 0) {
    const result = await runSkills(["remove", "-g", "-y", ...locked], { env: io.env, cwd: locations.home });
    if (result.code !== 0) {
      throw new UserError(`Removing ${listed(locked)} failed:\n${result.output.trim()}\n\nNext: rerun \`${USAGE}\` in the set's clone.`);
    }
  }
  for (const name of loose) {
    for (const dir of [skillsDir, linksDir]) rmSync(join(dir, name), { recursive: true, force: true });
  }
  return { removed: others };
}

/** The names in a folder, none when it's absent. */
function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** Tars what exists of `paths` into `<config>/backups/<date>.tar.gz`; returns that path. */
async function snapshot(locations: Locations, paths: string[]): Promise<string> {
  const backups = join(locations.configDir, "backups");
  mkdirSync(backups, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  let archive = join(backups, `${date}.tar.gz`);
  for (let n = 2; existsSync(archive); n++) archive = join(backups, `${date}-${n}.tar.gz`);
  const present = paths.filter((path) => existsSync(path) || isLink(path)).map((path) => relative("/", path));
  await promisify(execFile)("tar", ["-czf", archive, "-C", "/", ...present]);
  return archive;
}

/** The clone of the set that `io.cwd` is in, and the group holding `setup-moro-skills`; a stop saying to run it from the clone otherwise. */
async function cloneHere(io: MoroIo): Promise<{ clone: string; group: string }> {
  const root = await gitRunner(io.env)(["rev-parse", "--show-toplevel"], io.cwd).catch(() => undefined);
  const group = root === undefined ? undefined : skillsWithGroups(root).find(({ name }) => name === SKILL)?.group;
  if (root === undefined || group === undefined) {
    throw new UserError(
      `${io.cwd} isn't in a clone of the set, which holds ${SKILLS_DIR}/<group>/${SKILL}.\n\nNext: run \`${USAGE}\` from the set's clone.`,
    );
  }
  return { clone: root, group };
}

/** One paragraph: the clone, and what's installed at user level and from where. */
function stateParagraph(lock: Record<string, LockEntry>, clone: string): string {
  const counts = new Map<string, number>();
  for (const entry of Object.values(lock)) {
    const from = isFrom(entry, clone) ? "the clone" : entry.source;
    counts.set(from, (counts.get(from) ?? 0) + 1);
  }
  const total = Object.keys(lock).length;
  // The clone first, then other sources by name.
  const groups = [...counts]
    .sort(([a], [b]) => Number(b === "the clone") - Number(a === "the clone") || a.localeCompare(b))
    .map(([from, count]) => `${count} from ${from}`);
  const installed =
    total === 0
      ? "No skills are installed at user level."
      : counts.size === 1
        ? `${total === 1 ? "1 skill is" : `${total} skills are`} installed at user level, ${total === 1 ? "" : total === 2 ? "both " : "all "}from ${[...counts.keys()][0]}.`
        : `${total} skills are installed at user level: ${listed(groups)}.`;
  return `The set's clone is at ${clone}. ${installed}`;
}

/** `a`, `a and b`, `a, b and c`. */
function listed(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Whether two folders hold the same files with the same bytes. */
function sameFiles(a: string, b: string): boolean {
  const snapshot = (dir: string): Map<string, string> | undefined => {
    try {
      return new Map(
        readdirSync(dir, { recursive: true, encoding: "utf8" }).map((path) => {
          const stat = lstatSync(join(dir, path));
          return [path, stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? `link:${readlinkSync(join(dir, path))}` : readFileSync(join(dir, path)).toString("base64")];
        }),
      );
    } catch {
      return undefined;
    }
  };
  const [left, right] = [snapshot(a), snapshot(b)];
  return left !== undefined && right !== undefined && left.size === right.size && [...left].every(([path, content]) => right.get(path) === content);
}
