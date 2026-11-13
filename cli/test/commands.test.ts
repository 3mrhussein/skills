import { expect, test } from "vitest";
import { createWorld } from "./world.js";

test("moro --version prints the package version", async () => {
  const world = createWorld();

  const result = await world.run(["--version"]);

  expect(result).toMatchObject({ code: 0, stdout: "0.1.0\n" });
});

test("an unknown command fails and says what to run instead", async () => {
  const world = createWorld();

  const result = await world.run(["frobnicate"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unknown command: frobnicate");
  expect(result.stderr).toContain("Next: run `moro` to see this machine's state");
});
