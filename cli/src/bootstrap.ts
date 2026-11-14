// `moro bootstrap`: run from the set's clone. Records the clone in the device
// file, puts `setup-moro-skills` at user level, installed from the clone, and
// retires the shadowing skills the owner picks.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { readDevice, writeDevice } from "./device.js";
import { gitRunner } from "./git.js";
import { requireNewEnoughMoro } from "./hints.js";
import { isFrom, type LockEntry, readLock } from "./lock.js";
import { type Locations, readLocations } from "./locations.js";
import type { MoroIo } from "./main.js";
import { ENTRY_SKILL, SKILLS_DIR, skillsWithGroups, skillFolder } from "./set-layout.js";
import { type Likeness, readUserLevel, sameFiles, type ShadowingSkill } from "./shadowing.js";
import { isLink } from "./project.js";
import { runSkills } from "./skills-cli.js";
import { UserError } from "./user-error.js";

const USAGE = "moro bootstrap";

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
  const installed = lock[ENTRY_SKILL];
  const current =
    installed !== undefined &&
    isFrom(installed, clone) &&
    sameFiles(join(clone, skillFolder(ENTRY_SKILL, group)), join(locations.home, ".agents", "skills", ENTRY_SKILL));
  say(stateParagraph(lock, clone));

  const retired = await retireShadowing(io, locations, clone, lock, yes, say);

  // The device file is written first, so a failed install leaves it for the rerun.
  if (!recorded) writeDevice(locations.deviceFile, { clone });
  if (!current) {
    const result = await runSkills(["add", clone, "-g", "-y", "--skill", ENTRY_SKILL], { env: io.env, cwd: locations.home });
    if (result.code !== 0) {
      throw new UserError(`Installing ${ENTRY_SKILL} failed:\n${result.output.trim()}\n\nNext: rerun \`${USAGE}\` in the set's clone.`);
    }
  }

  const lines = [
    ...(recorded ? [] : ["Recorded the clone."]),
    ...(retired.length > 0 ? [`Removed: ${retired.join(", ")}.`] : []),
    ...(current ? [] : [`${installed ? "Reinstalled" : "Installed"}: ${ENTRY_SKILL}.`]),
  ];
  say(`\n${lines.length > 0 ? `${lines.join("\n")}\n\nNext: open a project and run \`/setup-moro-skills\`` : "Up to date."}`);
  return 0;
}

/**
 * Retires the shadowing skills the owner picks, so none hides a project's copy of a set skill.
 * Shows them in one table that is also the picker, names every other user-level skill and leaves it alone,
 * then snapshots before the first removal.
 */
async function retireShadowing(
  io: MoroIo,
  locations: Locations,
  clone: string,
  lock: Record<string, LockEntry>,
  yes: boolean,
  say: (text: string) => void,
): Promise<string[]> {
  const { shadowing, others, skillsDir, linksDir } = readUserLevel(locations, clone, lock);
  const rows = [...shadowing].sort((a, b) => LABELS[a.likeness.kind].order - LABELS[b.likeness.kind].order || a.name.localeCompare(b.name));
  const ticked = (skill: ShadowingSkill) => LABELS[skill.likeness.kind].ticked;
  const left = others.length > 0 ? `Left at user level: ${listed(others)}.` : undefined;

  if (rows.length === 0) {
    if (left) say(`\n${left}`);
    return [];
  }
  const count = rows.length === 1 ? "1 user-level skill shadows" : `${rows.length} user-level skills shadow`;
  say(`\n${count} the set's. Every removal is snapshotted first.\n\n${shadowTable(rows, io.stdout.isTTY === true)}`);
  if (left) say(`\n${left}`);

  const picked = yes
    ? rows.filter(ticked).map((skill) => skill.name)
    : await io.prompter.multiSelect({
        message: "Which shadowing skills should go?",
        choices: rows.map((skill) => ({ value: skill.name, label: skill.name, picked: ticked(skill) })),
        listed: true,
      });
  const retire = rows.filter((skill) => picked.includes(skill.name));

  if (retire.length > 0) {
    const archive = await snapshot(locations, [skillsDir, linksDir, locations.lockFile]);
    say(`\nSnapshot: ${archive}\nTo restore by hand: tar -xzf ${archive} -C /`);
    const locked = retire.filter((skill) => skill.locked).map((skill) => skill.name);
    if (locked.length > 0) {
      const result = await runSkills(["remove", "-g", "-y", ...locked], { env: io.env, cwd: locations.home });
      if (result.code !== 0) {
        throw new UserError(`Removing ${listed(locked)} failed:\n${result.output.trim()}\n\nNext: rerun \`${USAGE}\` in the set's clone.`);
      }
    }
    for (const skill of retire.filter((candidate) => !candidate.locked)) {
      for (const dir of [skillsDir, linksDir]) rmSync(join(dir, skill.name), { recursive: true, force: true });
    }
  }
  const kept = rows.filter((row) => !picked.includes(row.name));
  if (kept.length > 0) {
    const lines = kept.map((skill) => `Kept: ${skill.name}. It shadows a project's install; compare it with the set's copy, then rerun ./install.sh.`);
    say(`${retire.length > 0 ? "" : "\n"}${lines.join("\n")}`);
  }
  return retire.map((skill) => skill.name).sort();
}

/** Each likeness's row: where it sorts, whether it starts ticked, its label against the set's copy and its recommendation. */
const LABELS: Record<Likeness["kind"], { order: number; ticked: boolean; against: (source: string) => string; recommended: string }> = {
  same: { order: 0, ticked: true, against: () => "same as the set's", recommended: "remove" },
  from: { order: 1, ticked: true, against: (source) => `from ${source}, like the set's`, recommended: "remove: the set's copy replaces it" },
  differs: { order: 2, ticked: false, against: () => "differs from the set's", recommended: "keep: may hold your edits" },
};
/** Column widths past which a cell wraps onto the next line. */
const AGAINST_WIDTH = 30;
const RECOMMENDED_WIDTH = 25;
const MAX_FILES = 3;

/** The shadowing skills as one aligned table, numbered and ticked as the picker below it reads them. The Recommended column is dim in a terminal. */
function shadowTable(rows: ShadowingSkill[], terminal: boolean): string {
  const dim = (text: string) => (terminal && text !== "" ? `\x1b[2m${text}\x1b[22m` : text);
  const cells = rows.map((skill) => {
    const { likeness } = skill;
    const label = LABELS[likeness.kind];
    const shown = likeness.kind === "differs" ? likeness.files.slice(0, MAX_FILES) : [];
    const more = likeness.kind === "differs" && likeness.files.length > MAX_FILES ? [`+${likeness.files.length - MAX_FILES} more`] : [];
    return {
      skill,
      against: wrap(label.against(likeness.kind === "from" ? likeness.source : ""), AGAINST_WIDTH),
      recommended: wrap(label.recommended, RECOMMENDED_WIDTH),
      files: shown.length > 0 ? [...shown, ...more].join(", ") : undefined,
    };
  });
  const header = { name: "Skill", against: "Against the set's copy", recommended: "Recommended" };
  const width = {
    number: String(rows.length).length,
    name: Math.max(header.name.length, ...rows.map((skill) => skill.name.length)),
    against: Math.max(header.against.length, ...cells.flatMap((cell) => cell.against.map((line) => line.length))),
  };
  const lead = (number: string, tick: string) => `  ${number.padStart(width.number)}. ${tick} `;
  const blank = " ".repeat(lead("", "[x]").length);
  const GAP = "    ";
  const line = (start: string, name: string, against: string, recommended: string) =>
    `${start}${name.padEnd(width.name)}${GAP}${against.padEnd(width.against)}${GAP}${recommended}`.trimEnd();

  const lines = [line(blank, header.name, header.against, header.recommended)];
  cells.forEach((cell, index) => {
    const height = Math.max(cell.against.length, cell.recommended.length);
    for (let row = 0; row < height; row++) {
      const start = row === 0 ? lead(String(index + 1), LABELS[cell.skill.likeness.kind].ticked ? "[x]" : "[ ]") : blank;
      lines.push(line(start, row === 0 ? cell.skill.name : "", cell.against[row] ?? "", dim(cell.recommended[row] ?? "")));
    }
    if (cell.files) lines.push(`${blank}${" ".repeat(width.name)}${GAP}  ${cell.files}`);
  });
  return lines.join("\n");
}

/** Splits text into lines of at most `width` characters at spaces; a word longer than that stays on the line before it. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const word of text.split(" ")) {
    const last = lines.at(-1);
    if (last !== undefined && (last.length + 1 + word.length <= width || word.length > width)) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines;
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
  const group = root === undefined ? undefined : skillsWithGroups(root).find(({ name }) => name === ENTRY_SKILL)?.group;
  if (root === undefined || group === undefined) {
    throw new UserError(
      `${io.cwd} isn't in a clone of the set, which holds ${SKILLS_DIR}/<group>/${ENTRY_SKILL}.\n\nNext: run \`${USAGE}\` from the set's clone.`,
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
