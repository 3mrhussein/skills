import { expect, test } from "vitest";
import { join } from "node:path";
import { createWorld, writeFiles } from "./world.js";

const deviceFile = JSON.stringify({ clone: "/somewhere/clone" });
const NEXT = "Next: run ./install.sh in the set's clone.";

test("every command but bootstrap and --version stops without the device file", async () => {
  const world = createWorld();

  for (const argv of [[], ["add", "owner/repo"]]) {
    const result = await world.run(argv);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(NEXT);
  }
  expect((await world.run(["--version"])).code).toBe(0);
});

test("a device file that records no clone counts as none", async () => {
  const world = createWorld();
  writeFiles(world.home, { ".config/moro/config.json": JSON.stringify({ work: false }) });

  expect((await world.run([])).stderr).toContain(NEXT);
});

test("moro finds the device file in the home's config folder", async () => {
  const world = createWorld();
  writeFiles(world.home, { ".config/moro/config.json": deviceFile });

  const result = await world.run([]);

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
});

test("XDG_CONFIG_HOME moves moro's config folder", async () => {
  const world = createWorld();
  const configHome = join(world.root, "xdg-config");
  world.env.XDG_CONFIG_HOME = configHome;
  writeFiles(world.home, { ".config/moro/config.json": deviceFile });

  expect((await world.run([])).code).toBe(1);

  writeFiles(configHome, { "moro/config.json": deviceFile });

  expect((await world.run([])).code).toBe(0);
});
