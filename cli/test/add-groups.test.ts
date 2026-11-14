import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, readManifest, skillMd } from "./world.js";

test("add works on the device file's clone from any folder", async () => {
  const world = createWorld();
  world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "hello", "--yes"], { cwd: world.project });

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(clone, "skills/misc/hello/SKILL.md"))).toBe(true);
  expect(world.git(["log", "--format=%s", "-1"], clone)).toBe("add: tools hello");
});

test("skills land in the source's folder above them as their group, and --yes takes it", async () => {
  const world = createWorld();
  world.source("mattpocock/skills", {
    "skills/engineering/tdd/SKILL.md": skillMd("tdd"),
    "skills/productivity/grill/SKILL.md": skillMd("grill"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "mattpocock/skills", "tdd", "grill", "--yes"], { cwd: world.project });

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(clone, "skills/engineering/tdd/SKILL.md"))).toBe(true);
  expect(existsSync(join(clone, "skills/productivity/grill/SKILL.md"))).toBe(true);
  expect(readManifest(clone).recommended).toEqual([]);
  expect(readManifest(clone).dependsOn).toEqual({});
});

test("--group names the group for every skill", async () => {
  const world = createWorld();
  world.source("mattpocock/skills", { "skills/engineering/tdd/SKILL.md": skillMd("tdd") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "mattpocock/skills", "tdd", "--group", "testing", "--yes"], { cwd: world.project });

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(clone, "skills/testing/tdd/SKILL.md"))).toBe(true);
});

test("the group prompt recommends the source's folder, offers the set's groups and takes a typed group", async () => {
  const world = createWorld({ set: { "skills/mine/own/SKILL.md": skillMd("own") } });
  world.source("mattpocock/skills", {
    "skills/engineering/tdd/SKILL.md": skillMd("tdd"),
    "skills/productivity/grill/SKILL.md": skillMd("grill"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "mattpocock/skills", "tdd", "grill"], {
    cwd: world.project,
    answers: ["names", "engineering", { typed: "thinking" }, "no", [], [], "no"],
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[1]).toMatchObject({
    message: "Group for tdd in the set?",
    recommended: "engineering",
    allowTyped: "another group",
    choices: [
      { value: "engineering", label: "engineering" },
      { value: "mine", label: "mine" },
    ],
  });
  expect(result.prompts[2]).toMatchObject({ message: "Group for grill in the set?", recommended: "productivity" });
  expect(existsSync(join(clone, "skills/engineering/tdd/SKILL.md"))).toBe(true);
  expect(existsSync(join(clone, "skills/thinking/grill/SKILL.md"))).toBe(true);
});

test("the recommended question is asked once per run, and --recommended answers it", async () => {
  const world = createWorld();
  world.source("acme/tools", {
    "skills/eng/one/SKILL.md": skillMd("one"),
    "skills/eng/two/SKILL.md": skillMd("two"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const asked = await world.run(["add", "acme/tools", "one", "two"], {
    cwd: world.project,
    answers: ["names", "eng", "eng", "yes", [], [], "no"],
  });
  expect(asked.code, asked.stderr).toBe(0);
  expect(asked.prompts[3]).toMatchObject({ message: "Are one, two recommended?", recommended: "no" });
  expect(readManifest(clone).recommended).toEqual(["skills/eng/one", "skills/eng/two"]);

  const world2 = createWorld();
  world2.source("acme/tools", { "skills/eng/one/SKILL.md": skillMd("one") });
  const clone2 = world2.cloneSet();
  world2.recordClone(clone2);
  const flagged = await world2.run(["add", "acme/tools", "one", "--recommended", "--yes"], { cwd: world2.project });
  expect(flagged.code, flagged.stderr).toBe(0);
  expect(readManifest(clone2).recommended).toEqual(["skills/eng/one"]);
});

test("dependencies are a multi-select of set skills, ticking those the text mentions", async () => {
  const world = createWorld({
    set: { "skills/eng/spec/SKILL.md": skillMd("spec"), "skills/eng/other/SKILL.md": skillMd("other") },
  });
  world.source("acme/tools", {
    "skills/eng/tickets/SKILL.md": `${skillMd("tickets")}Run the spec skill first, not a specification.\n`,
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "tickets"], {
    cwd: world.project,
    answers: ["tickets", "eng", "no", ["spec"], "no"],
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[3]).toEqual({
    message: "Which set skills does tickets depend on?",
    choices: [
      { value: "other", label: "other" },
      { value: "spec", label: "spec", picked: true },
    ],
  });
  expect(readManifest(clone).dependsOn).toEqual({ tickets: ["spec"] });
});

test("--depends-on answers the dependency prompt, and --yes ticks the mentioned skills", async () => {
  const world = createWorld({ set: { "skills/eng/spec/SKILL.md": skillMd("spec"), "skills/eng/plan/SKILL.md": skillMd("plan") } });
  world.source("acme/tools", {
    "skills/eng/a/SKILL.md": skillMd("a"),
    "skills/eng/b/SKILL.md": `${skillMd("b")}Needs plan.\n`,
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "a", "--depends-on", "spec", "plan", "--yes"], { cwd: world.project });
  expect(result.code, result.stderr).toBe(0);
  expect(readManifest(clone).dependsOn).toEqual({ a: ["spec", "plan"] });

  const second = await world.run(["add", "acme/tools", "b", "--yes"], { cwd: world.project });
  expect(second.code, second.stderr).toBe(0);
  expect(readManifest(clone).dependsOn).toEqual({ a: ["spec", "plan"], b: ["plan"] });
});

test("an unknown --depends-on key stops the run", async () => {
  const world = createWorld();
  world.source("acme/tools", { "skills/eng/a/SKILL.md": skillMd("a") });
  world.recordClone(world.cloneSet());

  const result = await world.run(["add", "acme/tools", "a", "--depends-on", "ghost", "--yes"], { cwd: world.project });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("ghost is not a skill in the set");
});

test("--work is gone", async () => {
  const world = createWorld();
  world.recordClone(world.cloneSet());

  const result = await world.run(["add", "acme/tools", "a", "--work", "--yes"], { cwd: world.project });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unknown option: --work");
});

test("a name already in skills.local/ clashes, and the newcomer never lands there", async () => {
  const world = createWorld({ set: { "skills.local/hello/SKILL.md": skillMd("hello") } });
  world.source("acme/tools", { "skills/eng/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const yes = await world.run(["add", "acme/tools", "hello", "--yes"], { cwd: world.project });
  expect(yes.code).toBe(1);
  expect(yes.stderr).toContain("hello is already in the set (skills.local/hello).");

  const prompted = await world.run(["add", "acme/tools", "hello"], {
    cwd: world.project,
    answers: ["hello", "rename", { typed: "tools-hello" }, "eng", "no", "no"],
  });
  expect(prompted.code, prompted.stderr).toBe(0);
  expect(prompted.prompts[1]).toMatchObject({ choices: [{ value: "keep" }, { value: "rename" }] });
  expect(existsSync(join(clone, "skills/eng/tools-hello/SKILL.md"))).toBe(true);
  expect(readFileSync(join(clone, "skills.local/hello/SKILL.md"), "utf8")).toBe(skillMd("hello"));
});

test("a name in another group of skills/ clashes", async () => {
  const world = createWorld({ set: { "skills/mine/hello/SKILL.md": skillMd("hello") } });
  world.source("acme/tools", { "skills/eng/hello/SKILL.md": skillMd("hello") });
  world.recordClone(world.cloneSet());

  const result = await world.run(["add", "acme/tools", "hello", "--yes"], { cwd: world.project });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("hello is already in the set (skills/mine/hello).");
});

test("the closing next step names /setup-moro-skills", async () => {
  const world = createWorld();
  world.source("acme/tools", { "skills/eng/a/SKILL.md": skillMd("a") });
  world.recordClone(world.cloneSet());

  const result = await world.run(["add", "acme/tools", "a", "--yes"], { cwd: world.project });

  expect(result.stdout).toContain("Next: run /setup-moro-skills in each project that should get them.");
});
