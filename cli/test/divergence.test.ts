import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, skillMd, writeFiles, type World } from "./world.js";

const SET = {
  "skills/engineering/tdd/SKILL.md": skillMd("tdd"),
  "skills/engineering/diagnose/SKILL.md": skillMd("diagnose"),
  "skills/engineering/grill/SKILL.md": skillMd("grill"),
  "skills/misc/zoom/SKILL.md": skillMd("zoom"),
  "skills/misc/ship/SKILL.md": skillMd("ship"),
  "manifest.json": JSON.stringify({
    moro: "0.2.0",
    sources: {},
    skills: {},
    recommended: ["skills/engineering/tdd", "skills/engineering/diagnose", "skills/engineering/grill"],
    dependsOn: {},
  }),
};

interface Ctx {
  world: World;
  clone: string;
}

/** A project that took tdd, diagnose and grill from the set's clone. */
async function installed(files: Record<string, string> = {}): Promise<Ctx> {
  const world = createWorld({ set: SET });
  const clone = world.cloneSet();
  writeFiles(clone, files);
  world.recordClone(clone);
  const first = await world.run(["install", "--yes"]);
  expect(first.code, first.stderr).toBe(0);
  return { world, clone };
}

const copy = (world: World, name: string) => readFileSync(join(world.project, ".agents/skills", name, "SKILL.md"), "utf8");
const has = (world: World, name: string) => existsSync(join(world.project, ".agents/skills", name));

test("a project that matches the clone ends Up to date.", async () => {
  const { world } = await installed();

  const result = await world.run(["install", "--yes"]);

  expect(result.stdout).toMatch(/Up to date\.\n$/);
});

test("the report names each divergence before the picker and changes nothing", async () => {
  const { world, clone } = await installed();
  writeFiles(clone, { "skills/engineering/tdd/SKILL.md": `${skillMd("tdd")}\nnew in the set\n` });
  writeFiles(world.project, { ".agents/skills/diagnose/SKILL.md": `${skillMd("diagnose")}\nmine\n` });
  rmSync(join(clone, "skills/engineering/grill"), { recursive: true });
  writeFiles(world.project, { ".agents/skills/ship/SKILL.md": "stray ship\n" });

  const result = await world.run(["install"], { answers: [["tdd", "diagnose", "grill"], "no"] });

  expect(result.code, result.stderr).toBe(0);
  const report = result.stdout.split("\n").slice(0, 6).join("\n");
  expect(report).toContain("set changed: tdd");
  expect(report).toContain("edited here: diagnose");
  expect(report).toContain("gone from the set: grill");
  expect(report).toContain("not installed: zoom");
  expect(report).toContain("loose: ship");
  const labels = Object.fromEntries((result.prompts[0] as any).choices.map((c: any) => [c.value, c.label]));
  expect(labels).toMatchObject({
    tdd: "tdd (set changed)",
    diagnose: "diagnose (edited here)",
    grill: "grill (gone from the set)",
    zoom: "zoom (not installed)",
    ship: "ship (loose)",
  });
  expect(has(world, "grill")).toBe(true);
});

test("a set changed skill that stays ticked is copied again", async () => {
  const { world, clone } = await installed();
  writeFiles(clone, { "skills/engineering/tdd/SKILL.md": `${skillMd("tdd")}\nnew in the set\n` });

  const result = await world.run(["install"], { answers: [["tdd", "diagnose", "grill"]] });

  expect(copy(world, "tdd")).toContain("new in the set");
  expect(result.stdout).toContain("Updated: tdd.");
  expect((await world.run(["install", "--yes"])).stdout).toMatch(/Up to date\.\n$/);
});

test("unticking a gone from the set skill removes it", async () => {
  const { world, clone } = await installed();
  rmSync(join(clone, "skills/engineering/grill"), { recursive: true });

  const result = await world.run(["install"], { answers: [["tdd", "diagnose"]] });

  expect(has(world, "grill")).toBe(false);
  expect(result.stdout).toContain("Removed: grill.");
});

test("ticking an edited here skill shows the diff and keeps the project's copy by default", async () => {
  const { world, clone } = await installed();
  writeFiles(clone, { "skills/engineering/diagnose/SKILL.md": `${skillMd("diagnose")}\nset side\n` });
  writeFiles(world.project, { ".agents/skills/diagnose/SKILL.md": `${skillMd("diagnose")}\nproject side\n` });

  const result = await world.run(["install"], { answers: [["tdd", "diagnose", "grill"], "no"] });

  const question = result.prompts[1] as any;
  expect(question.message).toBe("Use the set's copy of diagnose?");
  expect(question.recommended).toBe("no");
  expect(result.stdout).toContain("-project side");
  expect(result.stdout).toContain("+set side");
  expect(copy(world, "diagnose")).toContain("project side");
});

test("answering yes replaces an edited here skill with the set's copy", async () => {
  const { world } = await installed();
  writeFiles(world.project, { ".agents/skills/diagnose/SKILL.md": `${skillMd("diagnose")}\nproject side\n` });

  await world.run(["install"], { answers: [["tdd", "diagnose", "grill"], "yes"] });

  expect(copy(world, "diagnose")).toBe(skillMd("diagnose"));
  expect((await world.run(["install", "--yes"])).stdout).toMatch(/Up to date\.\n$/);
});

test("a loose folder is offered unticked; ticking it asks, and no keeps the folder", async () => {
  const { world } = await installed();
  writeFiles(world.project, { ".agents/skills/ship/SKILL.md": "stray ship\n" });

  const result = await world.run(["install"], { answers: [["tdd", "diagnose", "grill", "ship"], "no"] });

  expect((result.prompts[0] as any).choices.find((c: any) => c.value === "ship").picked).toBe(false);
  expect((result.prompts[1] as any).message).toBe("Use the set's copy of ship?");
  expect(copy(world, "ship")).toBe("stray ship\n");
});

test("--yes updates set changed skills and removes gone ones, never touching edited here or loose ones", async () => {
  const { world, clone } = await installed();
  writeFiles(clone, {
    "skills/engineering/tdd/SKILL.md": `${skillMd("tdd")}\nnew in the set\n`,
    "skills/engineering/diagnose/SKILL.md": `${skillMd("diagnose")}\nset side\n`,
  });
  writeFiles(world.project, { ".agents/skills/diagnose/SKILL.md": `${skillMd("diagnose")}\nproject side\n` });
  rmSync(join(clone, "skills/engineering/grill"), { recursive: true });
  writeFiles(world.project, { ".agents/skills/ship/SKILL.md": "stray ship\n" });

  const result = await world.run(["install", "--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(copy(world, "tdd")).toContain("new in the set");
  expect(has(world, "grill")).toBe(false);
  expect(copy(world, "diagnose")).toContain("project side");
  expect(copy(world, "ship")).toBe("stray ship\n");
});

test("a local-only skill whose project copy came from an older clone copy is set changed", async () => {
  const { world, clone } = await installed({ "skills.local/deploy/SKILL.md": skillMd("deploy") });
  expect(has(world, "deploy")).toBe(true);
  writeFiles(clone, { "skills.local/deploy/SKILL.md": `${skillMd("deploy")}\nnewer\n` });

  const result = await world.run(["install"], { answers: [["tdd", "diagnose", "grill", "deploy"]] });

  expect(result.stdout).toContain("set changed: deploy");
  expect(copy(world, "deploy")).toContain("newer");
});

test("bare moro in a project prints the report and says to rerun /setup-moro-skills", async () => {
  const { world, clone } = await installed();
  writeFiles(clone, { "skills/engineering/tdd/SKILL.md": `${skillMd("tdd")}\nnew in the set\n` });

  const result = await world.run([]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("set changed: tdd");
  expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("Next: rerun `/setup-moro-skills`.");
  expect(copy(world, "tdd")).toBe(skillMd("tdd"));
});

test("bare moro in a project that matches the clone says Up to date.", async () => {
  const { world } = await installed();

  const result = await world.run([]);

  expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("Up to date.");
});

test("--use-set-copy replaces the named edited here skill without asking, and leaves the others", async () => {
  const { world } = await installed();
  writeFiles(world.project, {
    ".agents/skills/diagnose/SKILL.md": `${skillMd("diagnose")}\nproject side\n`,
    ".agents/skills/grill/SKILL.md": `${skillMd("grill")}\nproject side\n`,
  });

  const result = await world.run(["install", "--pick", "tdd", "diagnose", "grill", "--use-set-copy", "diagnose"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(copy(world, "diagnose")).toBe(skillMd("diagnose"));
  expect(copy(world, "grill")).toContain("project side");
});

test("--use-set-copy on a loose folder installs the set's skill over it", async () => {
  const { world } = await installed();
  writeFiles(world.project, { ".agents/skills/ship/SKILL.md": "stray ship\n" });

  const result = await world.run(["install", "--pick", "tdd", "diagnose", "grill", "ship", "--use-set-copy", "ship"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(copy(world, "ship")).toBe(skillMd("ship"));
});
