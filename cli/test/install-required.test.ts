import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { AGENTS, createWorld, skillMd, type World } from "./world.js";

const BASE = {
  moro: "0.2.0",
  sources: {},
  skills: {},
  recommended: ["skills/engineering/tdd", "skills/productivity/grill"],
  dependsOn: {},
};

function setup(rules: Record<string, unknown>): World {
  const world = createWorld({
    set: {
      "skills/engineering/tdd/SKILL.md": skillMd("tdd"),
      "skills/engineering/diagnose/SKILL.md": skillMd("diagnose"),
      "skills/productivity/grill/SKILL.md": skillMd("grill"),
      "skills/misc/zoom/SKILL.md": skillMd("zoom"),
      "manifest.json": JSON.stringify({ ...BASE, ...rules }),
    },
  });
  world.recordClone(world.cloneSet());
  return world;
}

const installed = (project: string) =>
  Object.keys(JSON.parse(readFileSync(join(project, "skills-lock.json"), "utf8")).skills).sort();

test("required skills show ticked and greyed out, and are always installed", async () => {
  const world = setup({ required: ["skills/misc/zoom"] });

  const result = await world.run(["install"], { answers: [["tdd"], "exclude", AGENTS, "symlink"] });

  const zoom = (result.prompts[0] as any).choices.find((c: any) => c.value === "zoom");
  expect([zoom.picked, zoom.disabled]).toEqual([true, "required by the set"]);
  expect(installed(world.project)).toEqual(["tdd", "zoom"]);
  expect(result.stdout).toContain("zoom: required by the set.");
});

test("dependencies of ticked skills, and theirs, show ticked and greyed out", async () => {
  const world = setup({ dependsOn: { tdd: ["diagnose"], diagnose: ["zoom"] } });

  const result = await world.run(["install"], { answers: [["tdd", "grill"], "exclude", AGENTS, "symlink"] });

  const choices = (result.prompts[0] as any).choices;
  const state = (name: string) => choices.find((c: any) => c.value === name);
  expect([state("diagnose").picked, state("diagnose").disabled]).toEqual([true, "needed by tdd"]);
  expect([state("zoom").picked, state("zoom").disabled]).toEqual([true, "needed by diagnose"]);
  expect(state("grill").disabled).toBeUndefined();
});

test("picking a skill whose dependency is unticked installs the dependency and says why", async () => {
  const world = setup({ dependsOn: { zoom: ["diagnose"] } });

  const result = await world.run(["install"], { answers: [["tdd", "zoom"], "exclude", AGENTS, "symlink"] });

  expect(installed(world.project)).toEqual(["diagnose", "tdd", "zoom"]);
  expect(result.stdout).toContain("diagnose: needed by zoom.");
});

test("a required skill the set doesn't hold stops before changing anything", async () => {
  const world = setup({ required: ["skills/misc/nope"] });

  const result = await world.run(["install", "--yes"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("skills/misc/nope");
  expect(existsSync(join(world.project, "skills-lock.json"))).toBe(false);
});

test("a dependency the set doesn't hold stops before changing anything", async () => {
  const world = setup({ dependsOn: { tdd: ["ghost"] } });

  const result = await world.run(["install", "--yes"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("ghost");
  expect(existsSync(join(world.project, "skills-lock.json"))).toBe(false);
});

test("--yes installs required skills and dependencies as well", async () => {
  const world = setup({ required: ["skills/misc/zoom"], dependsOn: { tdd: ["diagnose"] } });

  const result = await world.run(["install", "--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(installed(world.project)).toEqual(["diagnose", "grill", "tdd", "zoom", ].sort());
});
