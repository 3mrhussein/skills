// The `skills` CLI's lock: what one machine has installed, and from where.
import { readFileSync } from "node:fs";

export interface LockEntry {
  /** The source as the `skills` CLI names it, such as `owner/repo`. */
  source: string;
  sourceUrl: string;
  /** The path to the skill's `SKILL.md` in its source. */
  skillPath: string;
}

/** The installed skills by name; none when there's no lock or the `skills` CLI wouldn't read it. */
export function readLock(lockFile: string): Record<string, LockEntry> {
  try {
    const lock = JSON.parse(readFileSync(lockFile, "utf8")) as { skills?: Record<string, LockEntry> };
    return lock.skills ?? {};
  } catch {
    return {};
  }
}

/** Whether a lock entry was installed from this repo URL, however the URL was spelt. */
export function isFrom(entry: LockEntry, url: string): boolean {
  const normal = (text: string) => text.trim().replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  return normal(entry.sourceUrl) === normal(url);
}

/** The names of skills installed from this repo URL, from under `folder` in it. */
export function installedFrom(lock: Record<string, LockEntry>, url: string, folder: string): string[] {
  return Object.entries(lock)
    .filter(([, entry]) => isFrom(entry, url) && entry.skillPath.startsWith(`${folder}/`))
    .map(([name]) => name);
}
