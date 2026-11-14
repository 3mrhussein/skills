import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AGENTS, createWorld, skillMd, type World } from "./world.js";

const ENTRY = "setup-moro-skills";
const SET = {
  [`skills/meta/${ENTRY}/SKILL.md`]: skillMd(ENTRY),
  "skills/engineering/tdd/SKILL.md": skillMd("tdd"),
  "skills/productivity/grill/SKILL.md": skillMd("grill"),
  "skills/misc/zoom/SKILL.md": skillMd("zoom"),
  "manifest.json": JSON.stringify({
    moro: "0.2.0",
    sources: {},
    skills: {},
    recommended: ["skills/engineering/tdd", "skills/productivity/grill"],
    dependsOn: {},
  }),
};

function setup(): World {
  const world = createWorld({ set: SET });
  world.recordClone(world.cloneSet());
  return world;
}

const userLock = (world: World) => Object.keys(world.readLock()?.skills ?? {}).sort();
const projectLock = (world: World) =>
  Object.keys(JSON.parse(readFileSync(join(world.project, "skills-lock.json"), "utf8")).skills).sort();

test("run inside Claude Code, a project install still links every pick into .claude/skills", async () => {
  const world = setup();
  world.env.AI_AGENT = "claude-code_2-1-325_agent";

  const result = await world.run(["install", "--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(world.project, ".agents/skills/tdd/SKILL.md"))).toBe(true);
  expect(existsSync(join(world.project, ".claude/skills/tdd/SKILL.md"))).toBe(true);
  expect(result.stdout).toContain("Agents: claude-code, codex, github-copilot, antigravity.");
});

test("--agents names the agents; leaving out claude-code leaves .claude/skills alone", async () => {
  const world = setup();

  const result = await world.run(["install", "--yes", "--agents", "codex", "github-copilot"]);

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(world.project, ".agents/skills/tdd/SKILL.md"))).toBe(true);
  expect(existsSync(join(world.project, ".claude/skills/tdd"))).toBe(false);
});

test("a rerun that adds claude-code links the skills already installed", async () => {
  const world = setup();
  await world.run(["install", "--yes", "--agents", "codex"]);

  const result = await world.run(["install", "--yes", "--agents", "claude-code", "codex"]);

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(world.project, ".claude/skills/tdd/SKILL.md"))).toBe(true);
  expect(existsSync(join(world.project, ".claude/skills/grill/SKILL.md"))).toBe(true);
  expect(world.git(["status", "--porcelain"], world.project)).toBe("");
});

test("a rerun without --agents keeps claude-code when the project's skills are linked there", async () => {
  const world = setup();
  await world.run(["install", "--yes"]);

  const result = await world.run(["install", "--pick", "tdd", "grill", "zoom"]);

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(world.project, ".claude/skills/zoom/SKILL.md"))).toBe(true);
});

test("a skill the skills CLI skips is named under Not installed, not Installed", async () => {
  const world = createWorld({
    set: { ...SET, "skills/misc/broken/SKILL.md": "---\nname: broken\ndescription: Shared language: the tasks it runs.\n---\n\nBroken.\n" },
  });
  world.recordClone(world.cloneSet());

  const result = await world.run(["install", "--yes", "--pick", "tdd", "broken"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Installed: tdd.");
  expect(result.stdout).toMatch(/Not installed: broken \(claude-code/);
});

test("moro install --user installs the picks at user level for the agents, from any folder", async () => {
  const world = setup();

  const result = await world.run(["install", "--user", "--yes", "--pick", "tdd", "zoom"], { cwd: world.root });

  expect(result.code, result.stderr).toBe(0);
  expect(userLock(world)).toEqual(["tdd", "zoom"]);
  expect(existsSync(join(world.home, ".agents/skills/tdd/SKILL.md"))).toBe(true);
  expect(existsSync(join(world.home, ".claude/skills/tdd/SKILL.md"))).toBe(true);
  expect(existsSync(join(world.project, "skills-lock.json"))).toBe(false);
  expect(result.stdout).toContain("Installed: tdd, zoom.");
  expect(result.stdout).toContain("Next: restart your agents; the skills are at user level.");
});

test("moro install --user offers recommended skills ticked first, then installed ones on a rerun, and never the entry skill", async () => {
  const world = setup();

  const first = await world.run(["install", "--user"], { cwd: world.root, answers: [["tdd", "grill"], AGENTS, "symlink"] });
  const rerun = await world.run(["install", "--user"], { cwd: world.root, answers: [["tdd"]] });

  expect(first.code, first.stderr).toBe(0);
  const picker = first.prompts[0] as any;
  expect(picker.message).toBe("Which skills should user level have?");
  expect(picker.choices.map((c: any) => [c.value, !!c.picked])).toEqual([
    ["tdd", true],
    ["grill", true],
    ["zoom", false],
  ]);
  expect((rerun.prompts[0] as any).choices.map((c: any) => [c.value, !!c.picked])).toEqual([
    ["tdd", true],
    ["grill", true],
    ["zoom", false],
  ]);
  expect(rerun.stdout).toContain("Removed: grill.");
  expect(userLock(world)).toEqual(["tdd"]);
});

test("moro install --user leaves user-level skills from elsewhere alone", async () => {
  const world = setup();
  const other = world.source("acme/tools", { "skills/find-skills/SKILL.md": skillMd("find-skills") });
  expect((await world.skills(["add", other.url, "-g", "-y", "--skill", "find-skills"])).code).toBe(0);

  const result = await world.run(["install", "--user", "--yes", "--pick", "tdd"], { cwd: world.root });

  expect(result.code, result.stderr).toBe(0);
  expect(userLock(world)).toEqual(["find-skills", "tdd"]);
});

test("a project install marks skills already at user level and ticks only the recommended ones that aren't", async () => {
  const world = setup();
  await world.run(["install", "--user", "--yes", "--pick", "tdd"], { cwd: world.root });

  const result = await world.run(["install"], { answers: [["grill"], "exclude", AGENTS, "symlink"] });

  expect(result.code, result.stderr).toBe(0);
  const picker = result.prompts[0] as any;
  expect(picker.choices.map((c: any) => [c.value, c.label, !!c.picked])).toEqual([
    ["tdd", "tdd (installed (user))", false],
    ["grill", "grill", true],
    ["zoom", "zoom", false],
  ]);
  expect(projectLock(world)).toEqual(["grill"]);
  expect(result.stdout).not.toContain("Shadowed at user level");
});

test("bootstrap lists user-level skills installed from the set unticked, and --yes keeps them", async () => {
  const world = setup();
  await world.run(["install", "--user", "--yes", "--pick", "tdd"], { cwd: world.root });

  const result = await world.run(["bootstrap", "--yes"], { cwd: world.clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/\[ \] tdd +installed from the set/);
  expect(result.stdout).not.toContain("Removed: tdd");
  expect(result.stdout).not.toContain("Kept: tdd");
  expect(userLock(world)).toContain("tdd");
});

test("bare moro outside a project reports user level against the set, and names moro install --user", async () => {
  const world = setup();
  await world.run(["install", "--user", "--yes", "--pick", "tdd"], { cwd: world.root });
  world.git(["config", "user.name", "x"], world.clone);
  world.git(["config", "user.email", "x@moro.test"], world.clone);
  writeFileSync(join(world.clone, "skills/engineering/tdd/SKILL.md"), `${skillMd("tdd")}\nChanged.\n`);
  world.git(["commit", "-qam", "tdd: change"], world.clone);

  const result = await world.run([], { cwd: world.root });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("User level against the set:\n  set changed: tdd");
  expect(result.stdout).toContain("Next: run `moro install --user`.");
});

test("a project pick the set also put at user level is named once, with no rerun of ./install.sh", async () => {
  const world = setup();
  await world.run(["install", "--user", "--yes", "--pick", "tdd"], { cwd: world.root });

  const result = await world.run(["install", "--yes", "--keep-out", "--pick", "tdd", "grill"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Also at user level: tdd.");
  expect(result.stdout).not.toContain("Shadowed at user level");
  expect(result.stdout).toContain("Next: restart your agent in this project");
});

test("a first install without --agents asks which agents, the four ticked, after the git question", async () => {
  const world = setup();

  const result = await world.run(["install"], { answers: [["tdd"], "exclude", ["codex", "github-copilot"], "symlink"] });

  expect(result.code, result.stderr).toBe(0);
  const question = result.prompts[2] as any;
  expect(question.message).toBe("Which agents should these skills install for?");
  expect(question.choices.map((c: any) => [c.value, !!c.picked])).toEqual([
    ["claude-code", true],
    ["codex", true],
    ["github-copilot", true],
    ["antigravity", true],
    ["gemini-cli", false],
  ]);
  expect(existsSync(join(world.project, ".agents/skills/tdd/SKILL.md"))).toBe(true);
  expect(existsSync(join(world.project, ".claude/skills/tdd"))).toBe(false);
});

test("a rerun whose --agents leaves out claude-code takes the skills out of .claude/skills only", async () => {
  const world = setup();
  await world.run(["install", "--yes"]);

  const result = await world.run(["install", "--yes", "--agents", "codex"]);

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(world.project, ".claude/skills/tdd"))).toBe(false);
  expect(existsSync(join(world.project, ".agents/skills/tdd/SKILL.md"))).toBe(true);
  expect(projectLock(world)).toEqual(["grill", "tdd"]);
  expect(result.stdout).toContain("Removed from claude-code: grill, tdd.");
});

test("a first install asks symlink or copy, symlink first; copy puts a real folder in .claude/skills", async () => {
  const world = setup();

  const result = await world.run(["install"], { answers: [["tdd"], "exclude", AGENTS, "copy"] });

  expect(result.code, result.stderr).toBe(0);
  const question = result.prompts[3] as any;
  expect(question.message).toBe("Symlink the skills into each agent's folder, or copy them?");
  expect(question.recommended).toBe("symlink");
  expect(lstatSync(join(world.project, ".claude/skills/tdd")).isSymbolicLink()).toBe(false);
  expect(existsSync(join(world.project, ".claude/skills/tdd/SKILL.md"))).toBe(true);
});

test("symlink links .claude/skills to the shared copy, and a rerun keeps the method on disk", async () => {
  const world = setup();
  await world.run(["install", "--yes", "--pick", "tdd"]);
  expect(lstatSync(join(world.project, ".claude/skills/tdd")).isSymbolicLink()).toBe(true);

  const rerun = await world.run(["install", "--pick", "tdd", "grill"]);

  expect(rerun.code, rerun.stderr).toBe(0);
  expect(rerun.prompts).toHaveLength(0);
  expect(lstatSync(join(world.project, ".claude/skills/grill")).isSymbolicLink()).toBe(true);
});

test("switching method reinstalls every installed skill with the new one", async () => {
  const world = setup();
  await world.run(["install", "--yes", "--pick", "tdd", "grill"]);

  const toCopy = await world.run(["install", "--yes", "--copy"]);

  expect(toCopy.code, toCopy.stderr).toBe(0);
  for (const name of ["tdd", "grill"]) expect(lstatSync(join(world.project, `.claude/skills/${name}`)).isSymbolicLink()).toBe(false);
  expect(toCopy.stdout).toContain("Updated: grill, tdd.");

  const back = await world.run(["install", "--yes", "--symlink"]);

  expect(back.code, back.stderr).toBe(0);
  for (const name of ["tdd", "grill"]) expect(lstatSync(join(world.project, `.claude/skills/${name}`)).isSymbolicLink()).toBe(true);
});

test("bootstrap installs the entry skill for the four agents, and --agents names others", async () => {
  const world = setup();

  const four = await world.run(["bootstrap", "--yes"], { cwd: world.clone });
  expect(four.code, four.stderr).toBe(0);
  expect(lstatSync(join(world.home, `.claude/skills/${ENTRY}`)).isSymbolicLink()).toBe(true);

  const codex = createWorld({ set: SET });
  const result = await codex.run(["bootstrap", "--yes", "--agents", "codex"], { cwd: codex.cloneSet() });
  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(codex.home, `.agents/skills/${ENTRY}/SKILL.md`))).toBe(true);
  expect(existsSync(join(codex.home, `.claude/skills/${ENTRY}`))).toBe(false);
});

test("a bootstrap rerun links the entry skill into .claude/skills when it's missing there", async () => {
  const world = setup();
  await world.run(["bootstrap", "--yes", "--agents", "codex"], { cwd: world.clone });

  const result = await world.run(["bootstrap", "--yes"], { cwd: world.clone });

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(world.home, `.claude/skills/${ENTRY}/SKILL.md`))).toBe(true);
});
