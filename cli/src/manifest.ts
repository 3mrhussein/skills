// The manifest: the set's record of its sources and upstream skills.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "./user-error.js";

/** An ordered, literal, whole-word substitution: [from, to]. */
export type RenameRule = [string, string];

export interface Source {
  /** Anything `git clone` takes, with `owner/repo` shorthand for GitHub. */
  repo: string;
  rename: RenameRule[];
}

export interface UpstreamSkill {
  /** The source's id. */
  source: string;
  /** The skill's folder in the source. */
  path: string;
  /** The full SHA of the source commit the skill was last taken from. */
  pin: string;
  /** Upstream commits the owner skipped, as full SHAs. */
  skipped: string[];
}

export interface Manifest {
  /** The oldest moro that can read this manifest. */
  moro: string;
  sources: Record<string, Source>;
  skills: Record<string, UpstreamSkill>;
  /** Paths in the set (`skills/<group>/<name>`, or `local-only/*`) a project install ticks first. */
  recommended: string[];
  /** Paths in the set a project install always includes. */
  required?: string[];
  /** A key to the keys it needs. Never names a local-only skill. */
  dependsOn: Record<string, string[]>;
}

export const MANIFEST_FILE = "manifest.json";

export function readManifest(setDir: string, moroVersion: string): Manifest {
  const file = join(setDir, MANIFEST_FILE);
  if (!existsSync(file)) return { moro: moroVersion, sources: {}, skills: {}, recommended: [], dependsOn: {} };
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Manifest>;
  return { ...parsed, recommended: parsed.recommended ?? [], dependsOn: parsed.dependsOn ?? {} } as Manifest;
}

export function writeManifest(setDir: string, manifest: Manifest): void {
  const skills = Object.fromEntries(Object.entries(manifest.skills).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(setDir, MANIFEST_FILE), `${JSON.stringify({ ...manifest, skills }, null, 2)}\n`);
}

/** The id of the source with this repo, adding the source when it's new. */
export function addSource(manifest: Manifest, repo: string): string {
  const existing = Object.entries(manifest.sources).find(([, source]) => source.repo === repo);
  if (existing) return existing[0];
  const [owner, name] = repo.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).slice(-2);
  const id = [name!, `${owner}-${name}`].find((candidate) => !Object.hasOwn(manifest.sources, candidate));
  if (!id) {
    throw new UserError(`The source ids ${name} and ${owner}-${name} are both taken; add ${repo} to ${MANIFEST_FILE} by hand.`);
  }
  manifest.sources[id] = { repo, rename: [] };
  return id;
}

export function hasSkill(manifest: Manifest, name: string): boolean {
  return Object.hasOwn(manifest.skills, name);
}

/** The key of the set's skill taken from `path` in this source, if any. */
export function keyFor(manifest: Manifest, sourceId: string, path: string): string | undefined {
  return Object.entries(manifest.skills).find(([, skill]) => skill.source === sourceId && skill.path === path)?.[0];
}

/** Forgets a skill at `folder`: its manifest entry, its needs and its place in the recommended and required lists. */
export function forgetSkill(manifest: Manifest, key: string, folder: string | undefined): void {
  delete manifest.skills[key];
  delete manifest.dependsOn[key];
  manifest.recommended = manifest.recommended.filter((path) => path !== folder);
  if (manifest.required) manifest.required = manifest.required.filter((path) => path !== folder);
}
