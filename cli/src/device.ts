// The device file: where this device's clone of the set is. It lives in moro's
// config folder, outside every repo, so it is never committed.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type Env, readLocations } from "./locations.js";
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

/** The clone the device file records, wherever moro runs. */
export function findClone(io: { env: Env }): string {
  const clone = readDevice(readLocations(io.env).deviceFile)?.clone;
  if (!clone || !existsSync(join(clone, ".git"))) {
    throw new UserError(
      `The device file's clone${clone ? ` (${clone})` : ""} isn't a git clone.\n\nNext: run ./install.sh in the set's clone.`,
    );
  }
  return clone;
}

/**
 * The set the commands that change it work on: the trial worktree of the clone that holds
 * the current folder, so `moro add` and `moro sync` there commit on its branch; otherwise the clone.
 */
export function findSet(io: { env: Env; cwd: string }): string {
  const clone = findClone(io);
  return worktreeOf(clone, io.cwd) ?? clone;
}

/** The top folder of the linked worktree of `clone` that holds `folder`, if one does. */
export function worktreeOf(clone: string, folder: string): string | undefined {
  const worktrees = join(realpathSync(join(clone, ".git")), "worktrees");
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      // A linked worktree's `.git` is a file naming its folder under the clone's `.git/worktrees`.
      if (!statSync(dotGit).isFile()) return undefined;
      const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      if (!gitdir || !existsSync(resolve(dir, gitdir))) return undefined;
      return dirname(realpathSync(resolve(dir, gitdir))) === worktrees ? realpathSync(dir) : undefined;
    }
    if (dirname(dir) === dir) return undefined;
  }
}
