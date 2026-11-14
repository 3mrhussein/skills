// `moro bootstrap`: run from the set's clone. Records the clone in the device
// file and puts `setup-moro-skills` at user level, installed from the clone.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { readDevice, writeDevice } from "./device.js";
import { gitRunner } from "./git.js";
import { isFrom, type LockEntry, readLock } from "./lock.js";
import { readLocations } from "./locations.js";
import type { MoroIo } from "./main.js";
import { runSkills } from "./skills-cli.js";
import { UserError } from "./user-error.js";

const SKILL = "setup-moro-skills";
const USAGE = "moro bootstrap";

export async function bootstrap(io: MoroIo, argv: string[]): Promise<number> {
  const [arg] = argv;
  if (arg !== undefined) {
    throw new UserError(`${arg.startsWith("-") ? `Unknown option: ${arg}` : `moro bootstrap takes no ${arg}.`}\n\nNext: run \`${USAGE}\` in the set's clone`);
  }
  const locations = readLocations(io.env);
  const say = (text: string) => io.stdout.write(`${text}\n`);
  const clone = await findClone(io);

  // Explore.
  const lock = readLock(locations.lockFile);
  const recorded = readDevice(locations.deviceFile)?.clone === clone;
  const installed = lock[SKILL];
  const current =
    installed !== undefined &&
    isFrom(installed, clone) &&
    sameFiles(join(clone, "skills", SKILL), join(locations.home, ".agents", "skills", SKILL));
  say(stateParagraph(lock, clone));

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
    ...(current ? [] : [`${installed ? "Reinstalled" : "Installed"}: ${SKILL}.`]),
  ];
  say(`\n${lines.length > 0 ? `${lines.join("\n")}\n\nNext: open a project and run \`/setup-moro-skills\`` : "Up to date."}`);
  return 0;
}

/** The root of the clone of the set that `io.cwd` is in, or a stop saying to run it from the clone. */
async function findClone(io: MoroIo): Promise<string> {
  const root = await gitRunner(io.env)(["rev-parse", "--show-toplevel"], io.cwd).catch(() => undefined);
  if (root === undefined || !existsSync(join(root, "skills", SKILL, "SKILL.md"))) {
    throw new UserError(
      `${io.cwd} isn't in a clone of the set, which holds skills/${SKILL}.\n\nNext: run \`${USAGE}\` from the set's clone.`,
    );
  }
  return root;
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
