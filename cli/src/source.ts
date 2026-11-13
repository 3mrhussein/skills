// A source checked out at one commit, and the skills in it.
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { frontmatterName } from "./frontmatter.js";
import type { Git } from "./git.js";

export interface Checkout {
  dir: string;
  /** The full SHA checked out. */
  pin: string;
  remove(): void;
}

export interface FoundSkill {
  /** The frontmatter `name`. */
  name: string;
  /** The skill's folder, relative to the source's root. */
  path: string;
}

/** A file in a skill's folder: its path inside the folder, bytes and mode, or a symlink's target. */
export type SkillFile =
  | { path: string; content: Buffer; mode: number }
  | { path: string; symlink: string };

/** The source has no branch, tag or commit by this name. */
export class UnknownRevisionError extends Error {
  constructor(readonly revision: string) {
    super(`No branch, tag or commit named ${revision}`);
  }
}

/** Clones `url` and checks out `revision`, or the default branch's HEAD. */
export async function checkout(git: Git, url: string, revision: string | undefined): Promise<Checkout> {
  const dir = mkdtempSync(join(tmpdir(), "moro-source-"));
  const remove = () => rmSync(dir, { recursive: true, force: true });
  try {
    await git(["clone", "-q", "--no-checkout", url, dir], tmpdir());
    const pin = await resolveCommit(git, dir, revision ?? "HEAD");
    await git(["checkout", "-q", "--detach", pin], dir);
    return { dir, pin, remove };
  } catch (error) {
    remove();
    throw error;
  }
}

/** A commit, tag or local branch, or else a branch on the source's remote. */
async function resolveCommit(git: Git, dir: string, revision: string): Promise<string> {
  const verify = (name: string) => git(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], dir);
  return verify(revision)
    .catch(() => verify(`origin/${revision}`))
    .catch(() => {
      throw new UnknownRevisionError(revision);
    });
}

/** Every folder holding a `SKILL.md`, with its frontmatter `name`, under `subpath` when given. */
export function findSkills(dir: string, subpath?: string): FoundSkill[] {
  const inSubpath = (path: string) => !subpath || path === subpath || path.startsWith(`${subpath}/`);
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith("SKILL.md") && !path.split("/").includes(".git"))
    .filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"))
    .flatMap((path) => {
      const name = frontmatterName(readFileSync(join(dir, path), "utf8"));
      return name ? [{ name, path: dirname(path) }] : [];
    })
    .filter((skill) => inSubpath(skill.path));
}

/** Every file in a skill's folder, verbatim. */
export function readSkillFiles(folder: string): SkillFile[] {
  return readdirSync(folder, { recursive: true, encoding: "utf8" }).flatMap((path): SkillFile[] => {
    const full = join(folder, path);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return [{ path, symlink: readlinkSync(full) }];
    if (stat.isFile()) return [{ path, content: readFileSync(full), mode: stat.mode & 0o777 }];
    return [];
  });
}
