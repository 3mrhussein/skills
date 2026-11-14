// Where a project stands against the clone: the project's copy of each skill, the
// hash its `skills-lock.json` recorded at install time, and the clone's copy.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { agentFolders, readProjectLock } from "./project.js";
import { LOCAL_ONLY_DIR, skillFolder } from "./set-layout.js";

export const LABELS = ["set changed", "edited here", "gone from the set", "not installed", "loose"] as const;
export type Label = (typeof LABELS)[number];

/** A skill the clone holds. */
export interface SetSkill {
  name: string;
  group: string;
  localOnly?: boolean;
}

export interface Divergence {
  /** Each reported skill with its labels (one or two: a skill can be both edited here and set changed). */
  labels: Map<string, Label[]>;
  /** Skills in the project lock that came from the clone and that the clone no longer holds. */
  gone: string[];
}

/** The clone's folder for a skill. */
export function cloneCopy(clone: string, skill: SetSkill): string {
  return skill.localOnly ? join(clone, LOCAL_ONLY_DIR, skill.group, skill.name) : join(clone, skillFolder(skill.name, skill.group));
}

/** Compares each skill with the project lock. `current` are the names the lock records. */
export function diverge(top: string, clone: string, skills: SetSkill[], current: string[]): Divergence {
  const lock = readProjectLock(top);
  const labels = new Map<string, Label[]>();
  const add = (name: string, label: Label) => labels.set(name, [...(labels.get(name) ?? []), label]);

  for (const skill of skills) {
    const folder = projectCopy(top, skill.name);
    if (!current.includes(skill.name)) {
      if (folder) add(skill.name, "loose");
      else if (current.length > 0) add(skill.name, "not installed");
      continue;
    }
    const recorded = lock[skill.name]?.computedHash;
    if (!recorded) continue;
    if (folder && hashFolder(folder) !== recorded) add(skill.name, "edited here");
    if (hashFolder(cloneCopy(clone, skill)) !== recorded) add(skill.name, "set changed");
  }
  const held = new Set(skills.map((skill) => skill.name));
  const gone = current.filter((name) => !held.has(name) && fromClone(top, clone, lock[name]?.source));
  for (const name of gone) add(name, "gone from the set");
  return { labels, gone };
}

/** The project's copy of a skill: `<agent folder>/skills/<name>`, `.agents` first. */
export function projectCopy(top: string, name: string): string | undefined {
  return agentFolders(top)
    .map((entry) => join(top, entry, "skills", name))
    .find((path) => existsSync(path) && statSync(path).isDirectory());
}

/** The report's lines, one per label, in the ticket's order; empty when nothing diverges. */
export function reportLines(divergence: Divergence): string[] {
  return LABELS.flatMap((label) => {
    const names = [...divergence.labels].filter(([, found]) => found.includes(label)).map(([name]) => name);
    return names.length > 0 ? [`${label}: ${names.join(", ")}`] : [];
  });
}

/** True when the project differs from the clone in a way a rerun fixes (a skill that merely isn't installed doesn't count). */
export function needsRerun(divergence: Divergence): boolean {
  return [...divergence.labels.values()].some((found) => found.some((label) => label !== "not installed"));
}

/** A unified diff of the project's copy against the clone's (empty when they match). */
export function diffFolders(projectFolder: string, cloneFolder: string): string {
  const result = spawnSync("diff", ["-ru", projectFolder, cloneFolder], { encoding: "utf8" });
  return result.stdout ?? "";
}

/** The `skills` CLI's folder hash: sha256 over each file's relative path and bytes, sorted by path. */
function hashFolder(folder: string): string {
  const files: { path: string; content: Buffer }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && entry.name !== "node_modules") walk(full);
      } else if (entry.isFile()) {
        files.push({ path: full.slice(folder.length + 1).split(sep).join("/"), content: readFileSync(full) });
      }
    }
  };
  if (existsSync(folder)) walk(folder);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

/** True when a lock entry's source is the clone or a folder inside it. */
function fromClone(top: string, clone: string, source: string | undefined): boolean {
  if (!source) return false;
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  };
  const root = real(clone);
  const from = real(resolve(top, source));
  return from === root || from.startsWith(root + sep);
}
