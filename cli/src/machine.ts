// The per-machine file: the owner's choices for this machine. It lives in
// moro's config folder, outside every repo, so it is never committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "./user-error.js";

export interface MachineChoices {
  /** Whether this is a work machine. */
  work: boolean;
  /** Set skills the owner chose not to install here. */
  leftOut: string[];
  /** The set's clone on this machine, or null when there isn't one. */
  setRepo: string | null;
}

/** This machine's choices, or undefined when moro hasn't set it up. */
export function readMachine(file: string): MachineChoices | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: Partial<MachineChoices>;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<MachineChoices>;
  } catch {
    throw new UserError(`${file} isn't valid JSON.\n\nNext: fix or delete it, then rerun \`moro setup\`.`);
  }
  return {
    work: parsed.work === true,
    leftOut: Array.isArray(parsed.leftOut) ? parsed.leftOut : [],
    setRepo: typeof parsed.setRepo === "string" ? parsed.setRepo : null,
  };
}

/** Writes the choices, keeping any other key already in the file, such as one a newer moro wrote. */
export function writeMachine(file: string, choices: MachineChoices): void {
  mkdirSync(dirname(file), { recursive: true });
  let others: Record<string, unknown> = {};
  try {
    others = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // No file yet: nothing to keep.
  }
  const leftOut = [...new Set(choices.leftOut)].sort();
  const written = { ...others, work: choices.work, leftOut, setRepo: choices.setRepo };
  writeFileSync(file, `${JSON.stringify(written, null, 2)}\n`);
}
