// Shadowing skills: user-level skills that hide a project's copy of a set skill,
// because they share its name or were installed from the same upstream skill.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fromClone, hashFolder } from "./divergence.js";
import { isFrom, type LockEntry, readLock } from "./lock.js";
import type { Locations } from "./locations.js";
import { readManifest } from "./manifest.js";
import { cloneUrl } from "./ref.js";
import { ENTRY_SKILL, existingSkillFolder } from "./set-layout.js";
import { MORO_VERSION } from "./version.js";

/** The Claude app's own synced skills, in `~/.claude/skills`: not the owner's to retire. */
const SYNCED_DIR = "synced";

/** How a shadowing skill compares with the set's copy, in order of precedence. */
export type Likeness =
  /** The same files as the set's copy. */
  | { kind: "same" }
  /** Installed from the set's upstream skill's source and path, and unedited since. */
  | { kind: "from"; source: string }
  /** Anything else; `files` are the paths that differ, sorted. */
  | { kind: "differs"; files: string[] }
  /** Installed from the clone by \`moro install --user\`: the set's own user-level copy. */
  | { kind: "set" };

export interface ShadowingSkill {
  /** Its user-level name. */
  name: string;
  /** The set skill it hides. */
  setName: string;
  /** Whether the user-level lock records it (otherwise it is a loose folder). */
  locked: boolean;
  likeness: Likeness;
}

export interface UserLevel {
  shadowing: ShadowingSkill[];
  /** Every other user-level skill, sorted: not the set's to touch. */
  others: string[];
  skillsDir: string;
  linksDir: string;
}

/** The user-level skills, split into those that shadow a skill in the clone and the rest. `setup-moro-skills` is neither. */
export function readUserLevel(locations: Locations, clone: string, lock: Record<string, LockEntry>): UserLevel {
  const skillsDir = join(locations.home, ".agents", "skills");
  const linksDir = join(locations.home, ".claude", "skills");
  const loose = [...new Set([...entries(skillsDir), ...entries(linksDir)])].filter((name) => name !== SYNCED_DIR && !(name in lock));
  const names = [...Object.keys(lock), ...loose].filter((name) => name !== ENTRY_SKILL).sort();
  const manifest = readManifest(clone, MORO_VERSION);

  const shadowing: ShadowingSkill[] = [];
  const others: string[] = [];
  for (const name of names) {
    const entry = lock[name];
    const upstream = entry && upstreamKey(manifest, entry);
    const setName = existingSkillFolder(clone, name) ? name : upstream;
    const setFolder = setName === undefined ? undefined : existingSkillFolder(clone, setName);
    if (setName === undefined || setName === ENTRY_SKILL || setFolder === undefined) {
      others.push(name);
      continue;
    }
    const userCopy = [join(skillsDir, name), join(linksDir, name)].find((folder) => existsSync(folder)) ?? join(skillsDir, name);
    const files = differingFiles(userCopy, join(clone, setFolder));
    const likeness: Likeness =
      entry && [clone, `${clone}-try`].some((root) => fromClone(locations.home, root, entry.source))
        ? { kind: "set" }
        : files.length === 0
        ? { kind: "same" }
        : entry && upstream === setName && unedited(userCopy, entry)
          ? { kind: "from", source: entry.source }
          : { kind: "differs", files };
    shadowing.push({ name, setName, locked: entry !== undefined, likeness });
  }
  return { shadowing, others, skillsDir, linksDir };
}

/** The picked set skills a user-level skill shadows, sorted, each as `name`, or `name (as <user-level name>)`. */
export function shadowedPicks(locations: Locations, clone: string, picks: string[]): string[] {
  return readUserLevel(locations, clone, readLock(locations.lockFile))
    .shadowing.filter((skill) => picks.includes(skill.setName) && skill.likeness.kind !== "set")
    .map((skill) => (skill.name === skill.setName ? skill.name : `${skill.setName} (as ${skill.name})`))
    .sort();
}

/** Whether two folders hold the same files with the same bytes. */
export function sameFiles(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && differingFiles(a, b).length === 0;
}

/** The key of the manifest's upstream skill this lock entry was installed from, if any. */
function upstreamKey(manifest: ReturnType<typeof readManifest>, entry: LockEntry): string | undefined {
  const folder = (path: string) => (path === "." ? "" : path.replace(/\/+$/, ""));
  return Object.entries(manifest.skills).find(([, skill]) => {
    const source = manifest.sources[skill.source];
    return (
      source !== undefined &&
      (entry.source === source.repo || isFrom(entry, cloneUrl(source.repo))) &&
      folder(dirname(entry.skillPath)) === folder(skill.path)
    );
  })?.[0];
}

/** Whether the folder still holds what its lock entry recorded at install: a GitHub tree hash, or the `skills` CLI's sha256 folder hash. */
function unedited(folder: string, entry: LockEntry): boolean {
  const recorded = entry.skillFolderHash ?? "";
  if (/^[0-9a-f]{40}$/i.test(recorded)) return gitTreeHash(folder) === recorded.toLowerCase();
  if (/^[0-9a-f]{64}$/i.test(recorded)) return hashFolder(folder) === recorded.toLowerCase();
  return false;
}

/** The hash git gives this folder as a tree. */
function gitTreeHash(folder: string): string {
  const sha1 = (data: Buffer) => createHash("sha1").update(data).digest();
  const object = (type: string, body: Buffer) => sha1(Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]));
  const tree = (dir: string): Buffer => {
    const items = readdirSync(dir).map((name) => {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return { name, sortName: name, mode: "120000", hash: object("blob", Buffer.from(readlinkSync(path))) };
      if (stat.isDirectory()) return { name, sortName: `${name}/`, mode: "40000", hash: tree(path) };
      return { name, sortName: name, mode: stat.mode & 0o111 ? "100755" : "100644", hash: object("blob", readFileSync(path)) };
    });
    items.sort((a, b) => Buffer.compare(Buffer.from(a.sortName), Buffer.from(b.sortName)));
    return object("tree", Buffer.concat(items.flatMap((item) => [Buffer.from(`${item.mode} ${item.name}\0`), item.hash])));
  };
  return tree(folder).toString("hex");
}

/** The paths, sorted, whose bytes differ between two folders or that only one holds. */
function differingFiles(a: string, b: string): string[] {
  const [left, right] = [contents(a), contents(b)];
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort();
  return paths.filter((path) => left.get(path) !== right.get(path));
}

/** Each file under a folder (followed when it is a link) by relative path, as a comparable string. */
function contents(dir: string): Map<string, string> {
  try {
    return new Map(
      readdirSync(dir, { recursive: true, encoding: "utf8" }).flatMap((path): [string, string][] => {
        const stat = lstatSync(join(dir, path));
        if (stat.isDirectory()) return [];
        return [[path, stat.isSymbolicLink() ? `link:${readlinkSync(join(dir, path))}` : readFileSync(join(dir, path)).toString("base64")]];
      }),
    );
  } catch {
    return new Map();
  }
}

/** The skill folders (or links to them) in a folder, none when it's absent; stray files and hidden names are not skills. */
function entries(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
