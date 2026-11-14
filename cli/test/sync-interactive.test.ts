import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, readManifest, SET_IDENTITY, skillMd, type World } from "./world.js";

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

const subject = (world: World, repo: string) => world.git(["log", "-1", "--format=%s"], repo);
const wording = (name: string, text: string) => skillMd(name).replace(`The ${name} skill.`, text);
const edit = (world: World, clone: string, name: string, text: string) => {
  writeFileSync(join(clone, "skills/misc", name, "SKILL.md"), wording(name, text));
  world.git(["commit", "-qam", "my edit"], clone);
};

test("a clean change defaults to accept, then asks to push and says what to do next", async () => {
  const { world, source, clone } = await setWithTools();
  const head = source.commit({ "skills/hello/extra.md": "extra\n" }, "Add extra");

  const result = await world.run(["sync"], { answers: ["accept", "yes"] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[0]).toMatchObject({ recommended: "accept" });
  expect(result.prompts[0]!.choices.map((choice) => choice.value)).toEqual(["accept", "skip", "later", "show"]);
  expect(result.prompts[1]).toMatchObject({ message: "Push now?", recommended: "yes" });
  expect(readManifest(clone).skills.hello.pin).toBe(head);
  expect(world.git(["log", "-1", "--format=%an <%ae>|%s"], clone)).toBe(`${SET_IDENTITY}|sync: accept hello`);
  expect(subject(world, world.set.bare)).toBe("sync: accept hello");
  expect(result.stdout).toContain("Accepted: hello.");
  expect(result.stdout).toMatch(/Pushed\.\n\nNext: run \/setup-moro-skills in each project that should get them\.\n$/);
});

test("a change that merges cleanly past a hand edit in another file still defaults to accept", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/extra.md": "extra\n" }, "Add extra");
  edit(world, clone, "hello", "My wording.");

  const result = await world.run(["sync"], { answers: ["accept", "no"] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[0]).toMatchObject({ recommended: "accept" });
  expect(subject(world, clone)).toBe("sync: accept hello");
});

test("a change that touches a hand-edited file has no default, lists later and skip before accept, show prints the diff, later brings it back", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": `${skillMd("hello")}Upstream line.\n` }, "Add a line");
  edit(world, clone, "hello", "My wording.");
  const commits = world.git(["rev-list", "--count", "HEAD"], clone);

  const result = await world.run(["sync"], { answers: ["show", "later"] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[0]).not.toHaveProperty("recommended");
  expect(result.prompts[0]!.choices.map((choice) => choice.value)).toEqual(["later", "skip", "accept", "show"]);
  expect(result.prompts).toHaveLength(2);
  expect(result.stdout).toContain("+Upstream line.");
  expect(result.stdout).toContain("Coming back next time: hello.");
  expect(world.git(["rev-list", "--count", "HEAD"], clone)).toBe(commits);
});

test("skip is committed, and declining the push says no device sees it yet", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/extra.md": "extra\n" }, "Add extra");

  const result = await world.run(["sync"], { answers: ["skip", "no"] });

  expect(result.code, result.stderr).toBe(0);
  expect(subject(world, clone)).toBe("sync: skip hello");
  expect(subject(world, world.set.bare)).not.toBe("sync: skip hello");
  expect(result.stdout).toContain("Skipped: hello.");
  expect(result.stdout).toContain("Not pushed: no device sees this until you push.");
});

test("a conflict is reported with how to resolve the markers, and the other skills are still decided", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": wording("hello", "Upstream wording.") });
  source.commit({ "skills/other/extra.md": "extra\n" });
  edit(world, clone, "hello", "My wording.");

  const result = await world.run(["sync"], { answers: ["accept", "accept", "no"] });

  expect(result.code).toBe(1);
  expect(readFileSync(join(clone, "skills/misc/hello/SKILL.md"), "utf8")).toContain("<<<<<<< ");
  expect(result.stdout).toContain("Conflict in SKILL.md of hello");
  expect(result.stdout).toContain("moro sync accept hello");
  expect(result.stdout).toContain("Accepted: other.");
  expect(subject(world, clone)).toBe("sync: accept other");
});

test("a held conflict from an earlier run is reported and the other skills are still decided", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": wording("hello", "Upstream wording.") });
  edit(world, clone, "hello", "My wording.");
  expect((await world.run(["sync", "accept", "hello"])).code).toBe(1);
  source.commit({ "skills/other/extra.md": "extra\n" });

  const result = await world.run(["sync"], { answers: ["accept", "no"] });

  expect(result.code).toBe(1);
  expect(result.stdout).toContain("hello is accepted but waiting for its conflict markers to be resolved");
  expect(result.stdout).toContain("Accepted: other.");
});

test("a conflict is reported, with the rest still coming back when it is left for later", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": wording("hello", "Upstream wording.") });
  source.commit({ "skills/other/extra.md": "extra\n" });
  edit(world, clone, "hello", "My wording.");

  const result = await world.run(["sync"], { answers: ["accept", "later"] });

  expect(result.code).toBe(1);
  expect(result.stdout).toContain("Conflict in SKILL.md of hello");
  expect(result.stdout).toContain("Coming back next time: other.");
});

test("--yes accepts the clean ones, leaves the rest undecided, asks nothing and pushes", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/extra.md": "extra\n" });
  source.commit({ "skills/other/SKILL.md": wording("other", "Upstream wording.") });
  edit(world, clone, "other", "My wording.");

  const result = await world.run(["sync", "--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toHaveLength(0);
  expect(result.stdout).toContain("Accepted: hello.");
  expect(result.stdout).toContain("Coming back next time: other.");
  expect(subject(world, world.set.bare)).toBe("sync: accept hello");
  expect(result.stdout).toContain("Pushed.");
});

test("nothing waiting says up to date and asks nothing", async () => {
  const { world } = await setWithTools();
  const result = await world.run(["sync"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Up to date.");
});
