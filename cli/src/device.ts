// The device file: where this device's clone of the set is. It lives in moro's
// config folder, outside every repo, so it is never committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "./user-error.js";

export interface Device {
  /** The absolute path of this device's clone of the set. */
  clone: string;
}

/** This device's file, or undefined when it has none or records no clone. */
export function readDevice(file: string): Device | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: { clone?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { clone?: unknown };
  } catch {
    throw new UserError(`${file} isn't valid JSON.\n\nNext: fix or delete it, then run ./install.sh in the set's clone.`);
  }
  return typeof parsed.clone === "string" ? { clone: parsed.clone } : undefined;
}

/** Writes the clone, keeping any other key already in the file, such as one a newer moro wrote. */
export function writeDevice(file: string, device: Device): void {
  mkdirSync(dirname(file), { recursive: true });
  let others: Record<string, unknown> = {};
  try {
    others = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // No file yet: nothing to keep.
  }
  writeFileSync(file, `${JSON.stringify({ ...others, clone: device.clone }, null, 2)}\n`);
}
