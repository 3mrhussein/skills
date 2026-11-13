import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, skillMd } from "./world.js";

test("the pinned skills CLI installs a set skill from the local bare repo into the world's home", async () => {
  const world = createWorld({ set: { "skills/hello/SKILL.md": skillMd("hello") } });

  const result = await world.skills(["add", world.set.url, "-g", "-y"]);

  expect(result.code, result.output).toBe(0);
  expect(world.readLock()?.skills.hello).toMatchObject({
    sourceUrl: world.set.url,
    skillPath: "skills/hello/SKILL.md",
  });
  const viaClaudeLink = readFileSync(join(world.home, ".claude", "skills", "hello", "SKILL.md"), "utf8");
  expect(viaClaudeLink).toBe(skillMd("hello"));
});

test("the skills CLI is pinned at 1.7.6 (the spec asks for 1.7.5 or later)", async () => {
  const world = createWorld();

  const { output } = await world.skills(["--version"]);

  expect(output.trim()).toBe("1.7.6");
});
