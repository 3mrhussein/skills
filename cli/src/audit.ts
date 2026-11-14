// `moro audit`: each skill at three layers, its source, the set and the current project (ADR 0007).
// It only reads. Nothing records projects (ADR 0005), so only the project holding the current folder is compared.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findClone, findSet } from "./device.js";
import { diverge, needsRerun, type SetSkill } from "./divergence.js";
import { gitRunner } from "./git.js";
import { RERUN_SETUP, UP_TO_DATE } from "./hints.js";
import type { MoroIo } from "./main.js";
import { PROJECT_LOCK, readProjectLock } from "./project.js";
import { ENTRY_SKILL, localOnlySkills, skillsWithGroups } from "./set-layout.js";
import { type UpstreamStanding, upstreamStandings } from "./sync.js";
import { UserError } from "./user-error.js";

const USAGE = "moro audit [--json]";
/** A cell with nothing to say. */
const NONE = "-";

interface Row {
  name: string;
  source: string;
  /** Upstream commits since the pin; null for an own skill or an unreachable source. */
  commits: number | null;
  set: string | null;
  handEdits: string[] | null;
  /** The divergence labels, or `same as set`; null outside a project and for the entry skill, which lives at user level. */
  project: string[] | null;
}

export async function audit(io: MoroIo, argv: string[]): Promise<number> {
  const json = argv.length === 1 && argv[0] === "--json";
  if (argv.length > 0 && !json) throw new UserError(`audit takes only --json.\n\nNext: run ${USAGE}`);
  const clone = findClone(io);
  const setDir = findSet(io);
  const top = await projectTop(io);
  const standings = await upstreamStandings(io, setDir);

  const skills: SetSkill[] = [...skillsWithGroups(setDir), ...localOnlySkills(clone).map((skill) => ({ ...skill, localOnly: true }))];
  const rows: Row[] = skills.map(({ name }) => ({ name, ...upstreamCells(standings.skills.get(name)), project: null }));
  let rerun = false;
  if (top) {
    const current = Object.keys(readProjectLock(top)).sort();
    const divergence = diverge(top, setDir, skills.filter(({ name }) => name !== ENTRY_SKILL), current, clone);
    rerun = needsRerun(divergence);
    for (const row of rows) {
      if (row.name === ENTRY_SKILL) continue;
      row.project = divergence.labels.get(row.name) ?? [current.includes(row.name) ? "same as set" : "not installed"];
    }
    // A skill the project took from the set that the set no longer holds.
    for (const name of divergence.gone) rows.push({ name, source: NONE, commits: null, set: null, handEdits: null, project: ["gone from the set"] });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const tryable = [...standings.skills].filter(([, standing]) => standing.tryable).map(([key]) => key).sort();
  const changed = [...standings.skills.values()].some((standing) => standing.source === "changed" || standing.source === "removed");
  const next =
    tryable.length > 0
      ? `Next: run \`moro try ${tryable[0]}\` to fall back or adapt.`
      : changed
        ? "Next: run `moro sync` to decide the upstream changes."
        : rerun
          ? RERUN_SETUP
          : standings.unreachable.size > 0
            ? "Next: check that this device can read the unreachable sources, then rerun `moro audit`."
            : UP_TO_DATE;

  for (const message of standings.unreachable.values()) io.stderr.write(`${message.split("\n\n")[0]}. Its skills show as unreachable.\n`);
  const code = standings.unreachable.size > 0 ? 1 : 0;

  if (json) {
    const unreachable = [...standings.unreachable].map(([source, message]) => ({ source, error: message.split("\n\n")[0] }));
    const report = { set: setDir, project: top ?? null, skills: rows, try: tryable, untaken: standings.newUpstream, unreachable, next };
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return code;
  }

  const head = ["skill", "source", "set", ...(top ? ["this project"] : [])];
  const table = [head, ...rows.map((row) => [row.name, row.source, row.set ?? NONE, ...(top ? [row.project?.join(", ") ?? NONE] : [])])];
  const widths = head.map((_, column) => Math.max(...table.map((cells) => cells[column]!.length)));
  const out = table.map((cells) => cells.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd());
  if (tryable.length > 0) {
    out.push("", "Upstream change and hand edits:", ...tryable.map((key) => `  ${key}: fall back or adapt? Next: run \`moro try ${key}\`.`));
  }
  if (standings.newUpstream.length > 0) {
    out.push("", "In the sources, not in the set:", ...standings.newUpstream.map(({ source, name, path }) => `  ${source}: ${name} (${path})`));
  }
  out.push("", next);
  io.stdout.write(`${out.join("\n")}\n`);
  return code;
}

/** The source and set cells of a skill: an own skill when the manifest doesn't track it. */
function upstreamCells(standing: UpstreamStanding | undefined): Omit<Row, "name" | "project"> {
  if (!standing) return { source: "own skill", commits: null, set: null, handEdits: null };
  const commits = standing.commits ?? null;
  const source = {
    "up to date": "up to date",
    changed: `upstream +${commits} commit${commits === 1 ? "" : "s"}`,
    removed: "removed upstream",
    unreachable: "unreachable",
  }[standing.source];
  const handEdits = standing.handEdits ?? null;
  const set = handEdits === null ? null : handEdits.length > 0 ? "hand edits" : "source's text";
  return { source, commits, set, handEdits };
}

/** The top of the git project holding the current folder, when it has a project lock; otherwise undefined. */
async function projectTop(io: MoroIo): Promise<string | undefined> {
  const top = await gitRunner(io.env)(["rev-parse", "--show-toplevel"], io.cwd).catch(() => undefined);
  return top && existsSync(join(top, PROJECT_LOCK)) ? top : undefined;
}
