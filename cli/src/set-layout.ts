// Where skills live in the set. Names are unique across both folders.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Upstream and own skills; work skills sit outside the `skills` CLI's default scan. */
const FOLDERS = { skills: "skills", work: "work" } as const;

/** The set's folder for a skill, relative to the set's root. */
export function skillFolder(name: string, work: boolean): string {
  return join(work ? FOLDERS.work : FOLDERS.skills, name);
}

/** The folder already holding a skill of this name, if any. */
export function existingSkillFolder(setDir: string, name: string): string | undefined {
  return [skillFolder(name, false), skillFolder(name, true)].find((folder) => existsSync(join(setDir, folder)));
}
