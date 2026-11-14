// Bare `moro`: the state of the clone outside a project, and the one next step.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findClone } from "./device.js";
import { type Git, gitRunner } from "./git.js";
import { BUILD_OLDER, RERUN_USER, SYNC_OLD, UNPUSHED, UP_TO_DATE } from "./hints.js";
import { projectStatus, userLevelReport } from "./install.js";
import { readLocations } from "./locations.js";
import type { MoroIo } from "./main.js";
import { MANIFEST_FILE } from "./manifest.js";
import { PROJECT_LOCK } from "./project.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_STALE_DAYS = 30;

export async function status(io: MoroIo): Promise<number> {
  const git = gitRunner(io.env);
  if (await inProject(git, io.cwd)) {
    return projectStatus(io, git);
  }
  const locations = readLocations(io.env);
  const clone = findClone(io);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], clone);
  const unpushed = await unpushedCommits(git, clone);
  const lastSync = await git(["log", "-1", "--format=%cI", "--grep=^sync: "], clone);

  const lines = [`Clone: ${clone} (${branch})`];
  lines.push(unpushed.length ? `Unpushed: ${unpushed.length}` : "Unpushed: none");
  for (const commit of unpushed) lines.push(`  ${commit}`);
  lines.push(`Last sync: ${lastSync ? lastSync.slice(0, 10) : "never"}`, "");
  const user = userLevelReport(io);
  if (user.lines.length > 0) lines.push("User level against the set:", ...user.lines.map((line) => `  ${line}`), "");
  lines.push(await nextStep(git, clone, locations.builtFrom, unpushed.length > 0, lastSync, user.rerun));
  io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

/** The one next step, in order: build older than the clone's cli/, unpushed commits, old sync, up to date. */
async function nextStep(git: Git, clone: string, builtFrom: string, unpushed: boolean, lastSync: string, userRerun: boolean): Promise<string> {
  if (await buildIsOlder(git, clone, builtFrom)) return BUILD_OLDER;
  if (userRerun) return RERUN_USER;
  if (unpushed) return UNPUSHED;
  if (lastSync) return Date.now() - Date.parse(lastSync) > SYNC_STALE_DAYS * DAY_MS ? SYNC_OLD : UP_TO_DATE;
  return hasUpstreamSkills(clone) ? SYNC_OLD : UP_TO_DATE;
}

/** A project is a git repo whose top level holds a `skills-lock.json` (`PROJECT_LOCK`). */
async function inProject(git: Git, cwd: string): Promise<boolean> {
  try {
    const top = await git(["rev-parse", "--show-toplevel"], cwd);
    return existsSync(join(top, PROJECT_LOCK));
  } catch {
    return false;
  }
}

async function unpushedCommits(git: Git, clone: string): Promise<string[]> {
  try {
    const out = await git(["log", "--format=%h %s", "@{upstream}..HEAD"], clone);
    return out ? out.split("\n") : [];
  } catch {
    return [];
  }
}

/** True when the clone's last `cli/` change isn't in the build. A build with no record can't be judged. */
async function buildIsOlder(git: Git, clone: string, builtFromFile: string): Promise<boolean> {
  if (!existsSync(builtFromFile)) return false;
  const built = readFileSync(builtFromFile, "utf8").trim();
  const lastCli = await git(["log", "-1", "--format=%H", "--", "cli"], clone);
  if (!lastCli) return false;
  try {
    await git(["merge-base", "--is-ancestor", lastCli, built], clone);
    return false;
  } catch {
    return true;
  }
}

function hasUpstreamSkills(clone: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(clone, MANIFEST_FILE), "utf8")) as { skills?: object };
    return Object.keys(manifest.skills ?? {}).length > 0;
  } catch {
    return false;
  }
}
