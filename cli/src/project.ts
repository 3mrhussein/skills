// What the `skills` CLI leaves in a project: its `skills-lock.json` and one folder per agent.
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_LOCK = "skills-lock.json";

/** One skill's entry in a project's lock. */
export interface ProjectLockEntry {
  source?: string;
  computedHash?: string;
}

/** The skills in the project's lock, by name; none when the lock is missing or unreadable. */
export function readProjectLock(top: string): Record<string, ProjectLockEntry> {
  try {
    return (JSON.parse(readFileSync(join(top, PROJECT_LOCK), "utf8")) as { skills?: Record<string, ProjectLockEntry> }).skills ?? {};
  } catch {
    return {};
  }
}

/** The project's agent folders (`.agents`, `.claude`, …), `.agents` first. */
export function agentFolders(top: string): string[] {
  return readdirSync(top)
    .filter((entry) => entry !== ".git" && entry !== "node_modules")
    .sort((a, b) => Number(b === ".agents") - Number(a === ".agents"));
}

/** The project's folders holding this skill: `<agent folder>/skills/<name>`, as the `skills` CLI lays them out. */
export function skillFolders(top: string, name: string): string[] {
  return agentFolders(top)
    .map((entry) => `${entry}/skills/${name}`)
    .filter((path) => existsSync(join(top, path)) || isLink(join(top, path)));
}

export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
