import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, skillMd, type World, writeFiles } from "./world.js";

const SKILL = "setup-moro-skills";

/** A set, a lock entry (`locked`), a loose folder in ~/.agents/skills (`loose`) and one in ~/.claude/skills (`solo`). */
async function messyWorld(): Promise<World> {
  const world = createWorld({ set: { [`skills/${SKILL}/SKILL.md`]: skillMd(SKILL) } });
  const source = world.source("acme/tools", { "skills/locked/SKILL.md": skillMd("locked") });
  expect((await world.skills(["add", source.url, "-g", "-y"])).code).toBe(0);
  writeFiles(world.home, {
    ".agents/skills/loose/SKILL.md": skillMd("loose"),
    ".claude/skills/solo/SKILL.md": skillMd("solo"),
  });
  symlinkSync(join(world.home, ".agents/skills/loose"), join(world.home, ".claude/skills/loose"));
  return world;
}

const today = () => new Date().toISOString().slice(0, 10);
const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const userLevel = (world: World) => ({
  lock: Object.keys(world.readLock()?.skills ?? {}).sort(),
  agents: list(join(world.home, ".agents/skills")),
  claude: list(join(world.home, ".claude/skills")),
});

test("one confirmation, default yes, retires lock entries and loose folders, leaving only setup-moro-skills", async () => {
  const world = await messyWorld();

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: ["yes"] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toHaveLength(1);
  expect(result.prompts[0]).toMatchObject({ recommended: "yes" });
  expect(result.stdout).toContain("Other user-level skills: locked, loose and solo.");
  expect(result.stdout).toContain("Removed: locked, loose, solo.");
  expect(userLevel(world)).toEqual({ lock: [SKILL], agents: [SKILL], claude: [SKILL] });
});

test("before the first removal it tars the skills folder, the Claude links and the lock, and prints how to restore", async () => {
  const world = await messyWorld();

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: ["yes"] });

  const archive = join(world.home, ".config/moro/backups", `${today()}.tar.gz`);
  expect(existsSync(archive)).toBe(true);
  expect(result.stdout).toContain(archive);
  expect(result.stdout).toContain(`tar -xzf ${archive} -C /`);
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  for (const part of [".agents/skills/loose/SKILL.md", ".agents/skills/locked/SKILL.md", ".claude/skills/solo/SKILL.md", ".claude/skills/loose", ".agents/.skill-lock.json"]) {
    expect(listing).toContain(part);
  }
  // Restoring by hand brings the retired skills back.
  execFileSync("tar", ["-xzf", archive, "-C", "/"]);
  expect(userLevel(world).agents).toContain("loose");
  expect(userLevel(world).lock).toContain("locked");
  expect(lstatSync(join(world.home, ".claude/skills/solo")).isDirectory()).toBe(true);
});

test("--yes removes them without asking, after the snapshot", async () => {
  const world = await messyWorld();

  const result = await world.run(["bootstrap", "--yes"], { cwd: world.clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(existsSync(join(world.home, ".config/moro/backups", `${today()}.tar.gz`))).toBe(true);
  expect(userLevel(world)).toEqual({ lock: [SKILL], agents: [SKILL], claude: [SKILL] });
});

test("declining keeps them all, takes no snapshot and warns that their names shadow project installs", async () => {
  const world = await messyWorld();

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: ["no"] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Kept: locked, loose and solo.");
  expect(result.stdout).toContain("shadow");
  expect(existsSync(join(world.home, ".config/moro/backups"))).toBe(false);
  expect(userLevel(world)).toEqual({
    lock: [SKILL, "locked"].sort(),
    agents: ["locked", "loose", SKILL].sort(),
    claude: ["locked", "loose", "solo", SKILL].sort(),
  });
});

test("with nothing else at user level it asks nothing and takes no snapshot", async () => {
  const world = createWorld({ set: { [`skills/${SKILL}/SKILL.md`]: skillMd(SKILL) } });
  mkdirSync(join(world.home, ".claude/skills"), { recursive: true });

  const result = await world.run(["bootstrap"], { cwd: world.clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(existsSync(join(world.home, ".config/moro/backups"))).toBe(false);
});
