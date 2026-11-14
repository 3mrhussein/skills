import { expect, test } from "vitest";
import { createWorld, skillMd, type World, writeFiles } from "./world.js";

const SKILL = "setup-moro-skills";
const SET = {
  [`skills/meta/${SKILL}/SKILL.md`]: skillMd(SKILL),
  "skills/engineering/tdd/SKILL.md": skillMd("tdd"),
  "skills/engineering/diagnose/SKILL.md": skillMd("diagnose"),
};

/** A bootstrapped device: setup-moro-skills is at user level. */
async function bootstrapped(): Promise<World> {
  const world = createWorld({ set: SET });
  expect((await world.run(["bootstrap"], { cwd: world.clone })).code).toBe(0);
  return world;
}

test("moro install never offers setup-moro-skills, and its closing line leads with the skill", async () => {
  const world = await bootstrapped();

  const result = await world.run(["install"], { answers: [["tdd"], "exclude"] });

  expect(result.code, result.stderr).toBe(0);
  expect((result.prompts[0] as any).choices.map((choice: any) => choice.value)).toEqual(["diagnose", "tdd"]);
  expect(result.stdout).toContain("Rerun `/setup-moro-skills` (or `moro install`) to change the picks.");
});

test("a project holding setup-moro-skills keeps it, and neither the report nor bare moro lists it", async () => {
  const world = await bootstrapped();
  await world.run(["install", "--pick", "tdd", "diagnose", "--keep-out"]);
  expect((await world.skills(["add", world.clone, "-y", "--skill", SKILL])).code).toBe(0);

  const status = await world.run([]);
  const rerun = await world.run(["install", "--pick", "tdd", "diagnose"]);

  expect(status.stdout).not.toContain(SKILL);
  expect(status.stdout.trimEnd().split("\n").at(-1)).toBe("Up to date.");
  expect(rerun.code, rerun.stderr).toBe(0);
  expect(rerun.stdout).toBe("Up to date.\n");
});

test("moro install warns when a picked skill is shadowed at user level, never naming setup-moro-skills", async () => {
  const world = await bootstrapped();
  writeFiles(world.home, { ".agents/skills/tdd/SKILL.md": skillMd("tdd"), ".agents/skills/zoom/SKILL.md": skillMd("zoom") });

  const result = await world.run(["install", "--pick", "tdd", "diagnose", "--keep-out"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Shadowed at user level: tdd\. .*\nNext: rerun \.\/install\.sh in the set's clone\.\n$/);
  expect(result.stdout.match(/Next:/g)).toHaveLength(1);
  expect(result.stdout).not.toMatch(/Shadowed.*(setup-moro-skills|zoom|diagnose)/);
});

test("moro install says nothing about shadowing when no picked skill is shadowed", async () => {
  const world = await bootstrapped();
  writeFiles(world.home, { ".agents/skills/tdd/SKILL.md": skillMd("tdd") });

  const result = await world.run(["install", "--pick", "diagnose", "--keep-out"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).not.toContain("Shadowed");
});

test("a manifest naming setup-moro-skills in required or dependsOn doesn't stop moro install", async () => {
  const world = createWorld({
    set: {
      ...SET,
      "manifest.json": JSON.stringify({
        moro: "0.2.0",
        sources: {},
        skills: {},
        recommended: [],
        required: [`skills/meta/${SKILL}`],
        dependsOn: { tdd: [SKILL] },
      }),
    },
  });
  expect((await world.run(["bootstrap"], { cwd: world.clone })).code).toBe(0);

  const result = await world.run(["install", "--pick", "tdd", "--keep-out"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Installed: tdd.");
});
