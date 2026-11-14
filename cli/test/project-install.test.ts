import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, skillMd, writeFiles, type World } from "./world.js";

const SET = {
  "skills/engineering/tdd/SKILL.md": skillMd("tdd"),
  "skills/engineering/diagnose/SKILL.md": skillMd("diagnose"),
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

/** The skills the project's `skills-lock.json` lists. */
const installed = (project: string) =>
  Object.keys(JSON.parse(readFileSync(join(project, "skills-lock.json"), "utf8")).skills).sort();

const excluded = (project: string) => readFileSync(join(project, ".git/info/exclude"), "utf8");

test("stops outside a git repo", async () => {
  const world = setup();

  const result = await world.run(["install"], { cwd: world.root });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("git");
});

test("first install offers recommended skills ticked, then experimental ones, under group headers", async () => {
  const world = setup();

  const result = await world.run(["install"], { answers: [["tdd", "grill"], "exclude"] });

  expect(result.code, result.stderr).toBe(0);
  const request = result.prompts[0] as any;
  expect(request.choices.map((c: any) => [c.value, c.section, c.group, !!c.picked])).toEqual([
    ["tdd", "Recommended", "engineering", true],
    ["grill", "Recommended", "productivity", true],
    ["diagnose", "Experimental", "engineering", false],
    ["zoom", "Experimental", "misc", false],
  ]);
  expect(installed(world.project)).toEqual(["grill", "tdd"]);
  expect(result.stdout).toContain("Installed: grill, tdd.");
});

test("first install asks to commit or keep out; keeping out excludes the skills and the lock", async () => {
  const world = setup();

  const result = await world.run(["install"], { answers: [["tdd"], "exclude"] });

  const question = result.prompts[1] as any;
  expect(question.message).toBe("Commit these skills to this project, or keep them out of git?");
  expect(question.recommended).toBe("exclude");
  expect(world.git(["status", "--porcelain"], world.project)).toBe("");
  expect(excluded(world.project)).toContain("/skills-lock.json");
  expect(excluded(world.project)).toContain("/.claude/skills/tdd");
});

test("choosing to commit leaves the skills visible to git", async () => {
  const world = setup();

  await world.run(["install"], { answers: [["tdd"], "commit"] });

  expect(world.git(["status", "--porcelain"], world.project)).toContain("skills-lock.json");
});

test("a rerun ticks the installed skills, adds new picks, removes unticked ones and doesn't ask again", async () => {
  const world = setup();
  await world.run(["install"], { answers: [["tdd", "grill"], "exclude"] });

  const result = await world.run(["install"], { answers: [["tdd", "zoom"]] });

  const request = result.prompts[0] as any;
  expect(request.choices.filter((c: any) => c.picked).map((c: any) => c.value)).toEqual(["tdd", "grill"]);
  expect(result.prompts).toHaveLength(1);
  expect(installed(world.project)).toEqual(["tdd", "zoom"]);
  expect(existsSync(join(world.project, ".claude/skills/grill"))).toBe(false);
  expect(result.stdout).toContain("Installed: zoom.");
  expect(result.stdout).toContain("Removed: grill.");
  expect(excluded(world.project)).toContain("/.claude/skills/zoom");
});

test("a current project ends Up to date.", async () => {
  const world = setup();
  await world.run(["install"], { answers: [["tdd"], "exclude"] });

  const result = await world.run(["install"], { answers: [["tdd"]] });

  expect(result.stdout).toContain("Up to date.");
});

test("--yes takes the recommended skills on a first install and keeps them out of git", async () => {
  const world = setup();

  const result = await world.run(["install", "--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(installed(world.project)).toEqual(["grill", "tdd"]);
  expect(world.git(["status", "--porcelain"], world.project)).toBe("");
  expect((await world.run(["install", "--yes"])).stdout).toContain("Up to date.");
});

test("runs at the git top level when started in a subfolder", async () => {
  const world = setup();
  const sub = join(world.project, "packages/a");
  mkdirSync(sub, { recursive: true });

  const result = await world.run(["install", "--yes"], { cwd: sub });

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(world.project, "skills-lock.json"))).toBe(true);
});

/** A clone with local-only skills, which are never committed to the set. */
function withLocalOnly(files: Record<string, string>): World {
  const world = createWorld({ set: SET });
  const clone = world.cloneSet();
  writeFiles(clone, files);
  world.recordClone(clone);
  return world;
}

test("local-only skills are offered under Recommended in the skills.local group, ticked on a first install", async () => {
  const world = withLocalOnly({ "skills.local/deploy/SKILL.md": skillMd("deploy") });

  const result = await world.run(["install"], { answers: [["tdd", "grill", "deploy"], "exclude"] });

  expect(result.code, result.stderr).toBe(0);
  const request = result.prompts[0] as any;
  expect(request.choices.map((c: any) => [c.value, c.section, c.group, !!c.picked])).toContainEqual([
    "deploy",
    "Recommended",
    "skills.local",
    true,
  ]);
  expect(installed(world.project)).toEqual(["deploy", "grill", "tdd"]);
  expect(readFileSync(join(world.project, ".claude/skills/deploy/SKILL.md"), "utf8")).toBe(skillMd("deploy"));
});

test("local-only skills stay out of git even when the project commits its other skills", async () => {
  const world = withLocalOnly({ "skills.local/deploy/SKILL.md": skillMd("deploy") });

  const result = await world.run(["install"], { answers: [["tdd", "deploy"], "commit"] });

  expect(result.code, result.stderr).toBe(0);
  const status = world.git(["status", "--porcelain", "-uall"], world.project);
  expect(status).toContain(".claude/skills/tdd");
  expect(status).not.toContain("deploy");
  expect(excluded(world.project)).toContain("/.claude/skills/deploy");
  expect(excluded(world.project)).not.toContain("/skills-lock.json");
});

test("a name in both skills/ and skills.local/ stops the install, naming both paths", async () => {
  const world = withLocalOnly({ "skills.local/tdd/SKILL.md": skillMd("tdd") });

  const result = await world.run(["install", "--yes"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("skills/engineering/tdd");
  expect(result.stderr).toContain("skills.local/tdd");
  expect(existsSync(join(world.project, "skills-lock.json"))).toBe(false);
});

test("the set ignores skills.local/ in git", () => {
  expect(readFileSync(join(__dirname, "../../.gitignore"), "utf8").split("\n")).toContain("skills.local/");
});

test("--pick answers the picker and --commit answers the question, so a skill can relay both without prompts", async () => {
  const world = setup();

  const result = await world.run(["install", "--pick", "diagnose", "tdd", "--commit"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(installed(world.project)).toEqual(["diagnose", "tdd"]);
  expect(world.git(["status", "--porcelain"], world.project)).toContain("skills-lock.json");
});

test("--keep-out answers the question the other way, and a rerun with --pick removes what isn't named", async () => {
  const world = setup();

  const first = await world.run(["install", "--pick", "tdd", "grill", "--keep-out"]);
  expect(first.code, first.stderr).toBe(0);
  expect(first.prompts).toEqual([]);
  expect(world.git(["status", "--porcelain"], world.project)).toBe("");

  const rerun = await world.run(["install", "--pick", "tdd"]);
  expect(rerun.code, rerun.stderr).toBe(0);
  expect(rerun.stdout).toContain("Removed: grill.");
  expect(installed(world.project)).toEqual(["tdd"]);
});

test("--pick names only skills the set holds, and --keep-out with --commit is refused", async () => {
  const world = setup();

  const unknown = await world.run(["install", "--pick", "nope"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("nope is not a skill in the set");

  const both = await world.run(["install", "--keep-out", "--commit"]);
  expect(both.code).toBe(1);
  expect(both.stderr).toContain("--keep-out or --commit");
  expect(existsSync(join(world.project, "skills-lock.json"))).toBe(false);
});

test("the terminal picker shows sections and groups as headers, and typing a group's name drops or picks the whole group", async () => {
  const dropped = await setup().run(["install", "--keep-out"], { typed: "productivity\n" });
  expect(dropped.code, dropped.stderr).toBe(0);
  expect(dropped.stdout).toContain(
    ["Recommended", "  engineering", "  1. [x] tdd", "  productivity", "  2. [x] grill", "Experimental", "  engineering", "  3. [ ] diagnose"].join("\n"),
  );
  expect(dropped.stdout).toContain("Type a group's name to pick or drop the whole group.");
  expect(dropped.stdout).toContain("Installed: tdd.");

  const picked = await setup().run(["install", "--keep-out"], { typed: "engineering\n" });
  expect(picked.code, picked.stderr).toBe(0);
  expect(picked.stdout).toContain("Installed: diagnose, grill, tdd.");
});
