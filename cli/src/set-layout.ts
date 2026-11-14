// Where skills live in the set: `skills/<group>/<name>` and, for the device's
// own skills, the gitignored `local-only/<group>/<name>`. Names are unique across both.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SKILLS_DIR = "skills";
export const LOCAL_ONLY_DIR = "local-only";
/** The entry skill: always at user level, the default way to set up a project, and never in a project install. */
export const ENTRY_SKILL = "setup-moro-skills";

/** The set's folder for a skill, relative to the set's root. */
export function skillFolder(name: string, group: string): string {
  return join(SKILLS_DIR, group, name);
}

/** The folder already holding a skill of this name, in any group of `skills/` or `local-only/`. */
export function existingSkillFolder(setDir: string, name: string): string | undefined {
  for (const root of [SKILLS_DIR, LOCAL_ONLY_DIR]) {
    for (const group of subfolders(setDir, root)) {
      const folder = join(root, group, name);
      if (existsSync(join(setDir, folder))) return folder;
    }
  }
  return undefined;
}

/** The groups in `skills/`, sorted. */
export function groupsInSet(setDir: string): string[] {
  return subfolders(setDir, SKILLS_DIR);
}

/** The names of the skills in `skills/` (not `local-only/`), sorted. */
export function skillsInSet(setDir: string): string[] {
  return groupsInSet(setDir)
    .flatMap((group) => subfolders(setDir, join(SKILLS_DIR, group)))
    .sort();
}

function subfolders(setDir: string, folder: string): string[] {
  const dir = join(setDir, folder);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** Every skill in `local-only/` with its group, sorted by group, then name. */
export function localOnlySkills(setDir: string): { name: string; group: string }[] {
  return subfolders(setDir, LOCAL_ONLY_DIR).flatMap((group) =>
    subfolders(setDir, join(LOCAL_ONLY_DIR, group)).map((name) => ({ name, group })),
  );
}

/** Every skill in `skills/` with its group, sorted by group, then name. */
export function skillsWithGroups(setDir: string): { name: string; group: string }[] {
  return groupsInSet(setDir).flatMap((group) =>
    subfolders(setDir, join(SKILLS_DIR, group)).map((name) => ({ name, group })),
  );
}
