// Every next-step hint moro prints about this device and its clone, written once.
// `manage-moro-skills` repeats these lines word for word.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readDevice } from "./device.js";
import { type Env, readLocations } from "./locations.js";
import { MANIFEST_FILE } from "./manifest.js";
import { UserError } from "./user-error.js";
import { MORO_VERSION } from "./version.js";

export const RERUN_INSTALL = "Next: rerun ./install.sh in the set's clone.";
export const NO_DEVICE_FILE = `This device has no device file, so moro doesn't know where the set's clone is.\n\nNext: run ./install.sh in the set's clone.`;
export const BUILD_OLDER = "Next: rerun ./install.sh, because the moro build is older than the clone's cli/.";
export const UNPUSHED = "Next: push the clone's commits (git push).";
export const SYNC_OLD = "Next: run `moro sync` to check upstream skills.";
export const RERUN_SETUP = "Next: rerun `/setup-moro-skills`.";
export const UP_TO_DATE = "Up to date.";

/**
 * Every command but `bootstrap` and `--version` starts here: it needs the device file,
 * and a clone whose manifest doesn't ask for a newer moro (`bootstrap` checks the latter itself). Nothing is read or written before this passes.
 */
export function requireDevice({ env }: { env: Env }): void {
  const device = readDevice(readLocations(env).deviceFile);
  if (!device) throw new UserError(NO_DEVICE_FILE);
  requireNewEnoughMoro(device.clone);
}

/** Stops an older moro before it reads or writes anything, when the clone's manifest asks for a newer one. */
export function requireNewEnoughMoro(clone: string): void {
  const needed = requiredMoro(clone);
  if (needed && compareVersions(needed, MORO_VERSION) > 0) {
    throw new UserError(`The set's manifest needs moro ${needed}, and this is ${MORO_VERSION}.\n\n${RERUN_INSTALL}`);
  }
}

/** The manifest's `moro` field, read without trusting anything else in the file. */
function requiredMoro(clone: string): string | undefined {
  const file = join(clone, MANIFEST_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const moro = (JSON.parse(readFileSync(file, "utf8")) as { moro?: unknown }).moro;
    return typeof moro === "string" ? moro : undefined;
  } catch {
    return undefined;
  }
}

function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split("-")[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
