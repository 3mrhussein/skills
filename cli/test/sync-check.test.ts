// Sync runs the workflow check: after an accept, and for the impact `show` names.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, skillMd } from "./world.js";

/** A set with `hello` and `other` added from one source, and that source's repo. */
async function setWithTools() {
  const world = createWorld();
  const source = world.source("acme/tools", {
    "skills/hello/SKILL.md": skillMd("hello"),
    "skills/other/SKILL.md": skillMd("other"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);
  const added = await world.run(["add", source.url, "hello", "other", "--yes"], { cwd: clone });
  expect(added.code, added.stderr).toBe(0);
  return { world, source, clone };
}

const calling = (name: string, callee: string) => `${skillMd(name)}Call the Skill tool with "${callee}".\n`;

test("accept prints the workflow check's findings after its commit, as a warning that doesn't block", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": `${calling("hello", "other")}Then call the Skill tool with \`diagnose\`.\n` }, "hello calls other");

  const result = await world.run(["sync", "accept", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(world.git(["log", "-1", "--format=%s"], clone)).toBe("sync: accept hello");
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
  expect(result.stdout).toContain(
    [
      "Warning: the workflow check found 3 problems in the set; fix them before you push (`moro check` lists them again):",
      '  hello calls "diagnose", which isn\'t in the set.',
      '  hello calls "other", but dependsOn.hello doesn\'t list it.',
      '  hello calls "diagnose", but dependsOn.hello doesn\'t list it.',
    ].join("\n"),
  );
  expect(result.stdout.indexOf("in one commit.")).toBeLessThan(result.stdout.indexOf("Warning: the workflow check"));
  expect(result.stdout).toMatch(/\nNext: run `moro sync status` for the next skill, then `git push` in the set's clone\.\n$/);
});

test("an accept that leaves the skills fitting together prints no warning", async () => {
  const { world, source } = await setWithTools();
  source.commit({ "skills/hello/extra.md": "extra\n" }, "Add extra");

  const result = await world.run(["sync", "accept", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).not.toContain("Warning");
});

test("interactive sync warns about the check's findings before offering the push", async () => {
  const { world, source } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": calling("hello", "other") }, "hello calls other");

  const result = await world.run(["sync", "--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Accepted: hello.");
  expect(result.stdout).toContain('  hello calls "other", but dependsOn.hello doesn\'t list it.\n');
  expect(result.stdout.indexOf("Warning: the workflow check")).toBeLessThan(result.stdout.indexOf("Pushed."));
});

test("show names the skill's impact: the skills that call it, directly or through another", async () => {
  const { world, source, clone } = await setWithTools();
  writeFileSync(join(clone, "skills/misc/other/SKILL.md"), calling("other", "hello"));
  world.git(["add", "-A"], clone);
  world.git(["commit", "-qm", "other calls hello"], clone);
  source.commit({ "skills/hello/extra.md": "extra\n" }, "Add extra");
  source.commit({ "skills/other/extra.md": "extra\n" }, "Add extra to other");

  const hello = await world.run(["sync", "show", "hello"]);
  expect(hello.code, hello.stderr).toBe(0);
  expect(hello.stdout).toContain("\nImpact: other calls hello directly.\n");

  mkdirSync(join(clone, "skills/misc/top"));
  writeFileSync(join(clone, "skills/misc/top/SKILL.md"), calling("top", "other"));
  const deeper = await world.run(["sync", "show", "hello"]);
  expect(deeper.stdout).toContain("\nImpact: other calls hello directly; top through other (top -> other -> hello).\n");

  const other = await world.run(["sync", "show", "other"]);
  expect(other.stdout).toContain("\nImpact: top calls other directly.\n");
});
