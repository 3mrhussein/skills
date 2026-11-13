import { expect, test } from "vitest";
import { join } from "node:path";
import { createWorld, writeFiles } from "./world.js";

const machineChoices = JSON.stringify({ work: false });

test("moro on a fresh machine says it isn't set up and points at moro setup", async () => {
  const world = createWorld();

  const result = await world.run([]);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("This machine isn't set up for moro's skill set.");
  expect(result.stdout).toContain("Next: run `moro setup`");
});

test("moro finds the per-machine file in the home's config folder", async () => {
  const world = createWorld();
  writeFiles(world.home, { ".config/moro/config.json": machineChoices });

  const result = await world.run([]);

  expect(result.stdout).not.toContain("isn't set up");
});

test("XDG_CONFIG_HOME moves moro's config folder", async () => {
  const world = createWorld();
  const configHome = join(world.root, "xdg-config");
  world.env.XDG_CONFIG_HOME = configHome;
  writeFiles(world.home, { ".config/moro/config.json": machineChoices });

  expect((await world.run([])).stdout).toContain("isn't set up");

  writeFiles(configHome, { "moro/config.json": machineChoices });

  expect((await world.run([])).stdout).not.toContain("isn't set up");
});
