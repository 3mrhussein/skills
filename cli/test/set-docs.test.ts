// The set's own skill and docs are committed where the spec puts them.
import { existsSync, readFileSync } from "node:fs";
import { expect, test } from "vitest";

const root = (path: string) => new URL(`../../${path}`, import.meta.url);

test("manage-moro-skills is committed in the clone's own skills folder, named like its folder", () => {
  const file = root(".claude/skills/manage-moro-skills/SKILL.md");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toMatch(/^---\nname: manage-moro-skills\n/);
});

test("the root README and CLAUDE.md exist", () => {
  expect(existsSync(root("README.md"))).toBe(true);
  expect(readFileSync(root("CLAUDE.md"), "utf8")).toContain("writing-for-agents");
});
