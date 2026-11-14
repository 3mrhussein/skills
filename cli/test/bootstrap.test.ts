import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, skillMd, type World, writeFiles } from "./world.js";

const SKILL = "setup-moro-skills";
const NEXT = "Next: open a project and run `/setup-moro-skills`";

function worldWithSet(): World {
  return createWorld({ set: { [`skills/${SKILL}/SKILL.md`]: skillMd(SKILL), "skills/other/SKILL.md": skillMd("other") } });
}

test("a first bootstrap records the clone, installs setup-moro-skills from it and says what's next", async () => {
  const world = worldWithSet();

  const result = await world.run(["bootstrap"], { cwd: world.clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(result.stdout).toBe(
    [
      `The set's clone is at ${world.clone}. No skills are installed at user level.`,
      "",
      "Recorded the clone.",
      `Installed: ${SKILL}.`,
      "",
      NEXT,
      "",
    ].join("\n"),
  );
  expect(world.readDeviceFile()).toEqual({ clone: world.clone });
  expect(Object.keys(world.readLock()!.skills)).toEqual([SKILL]);
  expect(world.readLock()!.skills[SKILL]!.sourceUrl).toBe(world.clone);
  expect(readFileSync(join(world.home, ".claude", "skills", SKILL, "SKILL.md"), "utf8")).toBe(skillMd(SKILL));
});

test("a rerun on a current device changes nothing and ends Up to date.", async () => {
  const world = worldWithSet();
  await world.run(["bootstrap"], { cwd: world.clone });

  const result = await world.run(["bootstrap"], { cwd: world.clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe(
    `The set's clone is at ${world.clone}. 1 skill is installed at user level, from the clone.\n\nUp to date.\n`,
  );
  expect(world.readDeviceFile()).toEqual({ clone: world.clone });
});

test("it reinstalls setup-moro-skills when the clone's copy differs from the installed one", async () => {
  const world = worldWithSet();
  await world.run(["bootstrap"], { cwd: world.clone });
  writeFileSync(join(world.clone, "skills", SKILL, "SKILL.md"), skillMd(SKILL).replace("The", "The newer"));

  const result = await world.run(["bootstrap"], { cwd: world.clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Reinstalled: ${SKILL}.\n\n${NEXT}\n`);
  expect(result.stdout).not.toContain("Recorded the clone.");
  expect(readFileSync(join(world.home, ".claude", "skills", SKILL, "SKILL.md"), "utf8")).toContain("The newer");
});

test("it works from a folder inside the clone", async () => {
  const world = worldWithSet();

  const result = await world.run(["bootstrap"], { cwd: join(world.clone, "skills", "other") });

  expect(result.code, result.stderr).toBe(0);
  expect(world.readDeviceFile()).toEqual({ clone: world.clone });
});

test("outside a clone of the set it stops, says to run it from the clone and changes nothing", async () => {
  const world = worldWithSet();

  for (const cwd of [world.project, world.root]) {
    const result = await world.run(["bootstrap"], { cwd });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("isn't in a clone of the set");
    expect(result.stderr).toContain("Next: run `moro bootstrap` from the set's clone.");
  }
  expect(world.readDeviceFile()).toBeUndefined();
  expect(world.readLock()).toBeUndefined();
});

test("it keeps keys in the device file that it doesn't know, and updates a moved clone", async () => {
  const world = worldWithSet();
  writeFiles(world.home, { ".config/moro/config.json": JSON.stringify({ clone: "/old/place", trial: "/somewhere" }) });

  await world.run(["bootstrap"], { cwd: world.clone });

  expect(world.readDeviceFile()).toEqual({ clone: world.clone, trial: "/somewhere" });
});

test("XDG_CONFIG_HOME moves the device file", async () => {
  const world = worldWithSet();
  world.env.XDG_CONFIG_HOME = join(world.root, "xdg-config");

  await world.run(["bootstrap"], { cwd: world.clone });

  expect(JSON.parse(readFileSync(join(world.root, "xdg-config", "moro", "config.json"), "utf8"))).toEqual({ clone: world.clone });
  expect(world.readDeviceFile()).toBeUndefined();
});

test("the state names what's installed and from where, and other sources' skills are left alone", async () => {
  const world = worldWithSet();
  const other = world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  expect((await world.skills(["add", other.url, "-g", "-y"])).code).toBe(0);
  const source = world.readLock()!.skills.hello!.source;

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: ["no"] });

  expect(result.stdout).toContain(`1 skill is installed at user level, from ${source}.`);
  expect(world.readLock()!.skills.hello).toBeDefined();
  expect(readFileSync(join(world.home, ".claude", "skills", "hello", "SKILL.md"), "utf8")).toBe(skillMd("hello"));
  expect(world.readLock()!.skills[SKILL]).toBeDefined();
});

test("bootstrap takes no arguments but --yes", async () => {
  const world = worldWithSet();

  const result = await world.run(["bootstrap", "--bogus"], { cwd: world.clone });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unknown option: --bogus");
  expect(world.readDeviceFile()).toBeUndefined();
});
