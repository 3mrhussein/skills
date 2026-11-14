// Fallback: the third sync answer, which drops a skill's hand edits and takes the latest upstream text.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, readManifest, SET_IDENTITY, skillMd, type World } from "./world.js";

/** A set with `hello` and `other` added from one source, and that source's repo. */
async function setWithTools(files: Record<string, string> = {}) {
  const world = createWorld();
  const source = world.source("acme/tools", {
    "skills/hello/SKILL.md": skillMd("hello"),
    "skills/other/SKILL.md": skillMd("other"),
    ...files,
  });
  const clone = world.cloneSet();
  world.recordClone(clone);
  const added = await world.run(["add", source.url, "hello", "other", "--yes"], { cwd: clone });
  expect(added.code, added.stderr).toBe(0);
  return { world, source, clone };
}

const wording = (name: string, text: string) => skillMd(name).replace(`The ${name} skill.`, text);
const helloFile = (clone: string, path = "SKILL.md") => join(clone, "skills/misc/hello", path);
const edit = (world: World, clone: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) writeFileSync(helloFile(clone, path), text);
  world.git(["commit", "-qam", "my edit"], clone);
};
const count = (world: World, clone: string) => world.git(["rev-list", "--count", "HEAD"], clone);

test("fallback drops the hand edits, takes the latest upstream text, moves the pin and lists the dropped files in its commit", async () => {
  const { world, source, clone } = await setWithTools({ "skills/hello/notes.md": "one\ntwo\n" });
  const head = source.commit({ "skills/hello/SKILL.md": wording("hello", "Upstream wording.") }, "Reword hello");
  edit(world, clone, { "SKILL.md": wording("hello", "My wording."), "notes.md": "ONE\ntwo\n" });

  const result = await world.run(["sync", "fallback", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(helloFile(clone), "utf8")).toBe(wording("hello", "Upstream wording."));
  expect(readFileSync(helloFile(clone, "notes.md"), "utf8")).toBe("one\ntwo\n");
  expect(readManifest(clone).skills.hello).toEqual({ source: "tools", path: "skills/hello", pin: head, skipped: [] });
  expect(world.git(["log", "-1", "--format=%an <%ae>|%s"], clone)).toBe(`${SET_IDENTITY}|sync: fall back hello`);
  expect(world.git(["log", "-1", "--format=%b"], clone)).toBe("Dropped the hand edits in SKILL.md, notes.md.");
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
  expect(result.stdout).toContain(`Fell back hello: dropped the hand edits in SKILL.md, notes.md and took the upstream text, pin now ${head.slice(0, 7)}, in one commit.`);
  expect(result.stdout).toMatch(/\nNext: run `moro sync status` for the next skill, then `git push` in the set's clone\.\n$/);
  expect((await world.run(["sync", "status"])).stdout).toContain("Up to date.");
});

test("fallback without hand edits takes the change as accept would, with nothing listed as dropped", async () => {
  const { world, source, clone } = await setWithTools();
  const head = source.commit({ "skills/hello/extra.md": "extra\n" }, "Add extra");

  const result = await world.run(["sync", "fallback", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(helloFile(clone, "extra.md"), "utf8")).toBe("extra\n");
  expect(readManifest(clone).skills.hello.pin).toBe(head);
  expect(world.git(["log", "-1", "--format=%s|%b"], clone)).toBe("sync: fall back hello|");
  expect(result.stdout).toContain(`Fell back hello: it had no hand edits, so it took the upstream changes as accept would, pin now ${head.slice(0, 7)}, in one commit.`);
});

test("fallback after a skip takes the skipped change too and clears skipped", async () => {
  const { world, source, clone } = await setWithTools();
  const skippedSha = source.commit({ "skills/hello/a.md": "a\n" }, "Add a");
  expect((await world.run(["sync", "skip", "hello"])).code).toBe(0);
  expect(readManifest(clone).skills.hello.skipped).toEqual([skippedSha]);
  const head = source.commit({ "skills/hello/b.md": "b\n" }, "Add b");

  const shown = await world.run(["sync", "show", "hello"]);
  expect(shown.stdout).toContain("Hand edits: a.md");
  expect(shown.stdout).toContain("Fallback drops them and takes the upstream text as it is.");
  expect(shown.stdout).toContain("Next: run `moro sync accept hello`, `moro sync skip hello` or `moro sync fallback hello`.");

  const result = await world.run(["sync", "fallback", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(helloFile(clone, "a.md"), "utf8")).toBe("a\n");
  expect(readFileSync(helloFile(clone, "b.md"), "utf8")).toBe("b\n");
  expect(readManifest(clone).skills.hello).toMatchObject({ pin: head, skipped: [] });
  expect(world.git(["log", "-1", "--format=%b"], clone)).toBe("Dropped the hand edits in a.md.");
});

test("fallback on a skill removed upstream is refused and changes nothing", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({}, "Remove hello", ["skills/hello"]);
  edit(world, clone, { "SKILL.md": wording("hello", "My wording.") });
  const commits = count(world, clone);

  const result = await world.run(["sync", "fallback", "hello"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("hello was removed upstream, so there is no upstream text to fall back to. Nothing was changed.");
  expect(result.stderr).toContain("Next: run `moro sync accept hello` to delete it from the set, or `moro sync skip hello` to keep it as an own skill.");
  expect(count(world, clone)).toBe(commits);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
  expect(readFileSync(helloFile(clone), "utf8")).toBe(wording("hello", "My wording."));
});

test("fallback with nothing waiting says so and commits nothing", async () => {
  const { world, clone } = await setWithTools();
  const commits = count(world, clone);

  const result = await world.run(["sync", "fallback", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("hello has no upstream changes since its pin, so there is nothing to fall back.");
  expect(count(world, clone)).toBe(commits);
});

test("fallback on an accept waiting for its conflict markers drops the markers and the hand edits", async () => {
  const { world, source, clone } = await setWithTools();
  const head = source.commit({ "skills/hello/SKILL.md": wording("hello", "Upstream wording.") });
  edit(world, clone, { "SKILL.md": wording("hello", "My wording.") });
  expect((await world.run(["sync", "accept", "hello"])).code).toBe(1);
  expect(readFileSync(helloFile(clone), "utf8")).toContain("<<<<<<< ");

  const skip = await world.run(["sync", "skip", "hello"]);
  expect(skip.stderr).toContain("or `moro sync fallback hello` to drop your hand edits");

  const result = await world.run(["sync", "fallback", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(helloFile(clone), "utf8")).toBe(wording("hello", "Upstream wording."));
  expect(readManifest(clone).skills.hello.pin).toBe(head);
  expect(world.git(["log", "-1", "--format=%s|%b"], clone)).toBe("sync: fall back hello|Dropped the hand edits in SKILL.md.");
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("status names fallback in its next step for a skill with hand edits", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": wording("hello", "Upstream wording.") });
  edit(world, clone, { "SKILL.md": wording("hello", "My wording.") });

  const result = await world.run(["sync", "status"]);

  expect(result.stdout).toContain(
    "Next: run `moro sync show hello`, then `moro sync accept hello`, `moro sync skip hello` or `moro sync fallback hello`.",
  );
});

test("interactive sync offers fallback after accept and skip for a skill with hand edits, never as the default", async () => {
  const { world, source, clone } = await setWithTools();
  const head = source.commit({ "skills/hello/SKILL.md": wording("hello", "Upstream wording.") });
  edit(world, clone, { "SKILL.md": wording("hello", "My wording.") });

  const result = await world.run(["sync"], { answers: ["fallback", "no"] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[0]).not.toHaveProperty("recommended");
  expect(result.prompts[0]!.choices.map((choice) => choice.value)).toEqual(["later", "skip", "accept", "fallback", "show"]);
  expect(result.prompts[0]!.choices.find((choice) => choice.value === "fallback")!.label).toBe(
    "Fall back: drop your hand edits in SKILL.md and take the upstream text as it is",
  );
  expect(readFileSync(helloFile(clone), "utf8")).toBe(wording("hello", "Upstream wording."));
  expect(readManifest(clone).skills.hello.pin).toBe(head);
  expect(world.git(["log", "-1", "--format=%s"], clone)).toBe("sync: fall back hello");
  expect(result.stdout).toContain("Fell back: hello.");
  expect(result.stdout).toContain("Not pushed: no device sees this until you push.");
});

test("a clean change past a hand edit recommends accept and still offers fallback after skip", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/extra.md": "extra\n" });
  edit(world, clone, { "SKILL.md": wording("hello", "My wording.") });

  const result = await world.run(["sync"], { answers: ["accept", "no"] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[0]).toMatchObject({ recommended: "accept" });
  expect(result.prompts[0]!.choices.map((choice) => choice.value)).toEqual(["accept", "skip", "fallback", "later", "show"]);
});

test("--yes never falls back", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": wording("hello", "Upstream wording.") });
  edit(world, clone, { "SKILL.md": wording("hello", "My wording.") });

  const result = await world.run(["sync", "--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Coming back next time: hello.");
  expect(readFileSync(helloFile(clone), "utf8")).toBe(wording("hello", "My wording."));
});

test("fallback prints the workflow check's findings after its commit", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": `${skillMd("hello")}Call the Skill tool with "other".\n` });
  edit(world, clone, { "SKILL.md": wording("hello", "My wording.") });

  const result = await world.run(["sync", "fallback", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain('  hello calls "other", but dependsOn.hello doesn\'t list it.\n');
  expect(result.stdout.indexOf("in one commit.")).toBeLessThan(result.stdout.indexOf("Warning: the workflow check"));
  expect(result.stdout.indexOf("Warning: the workflow check")).toBeLessThan(result.stdout.indexOf("Not pushed"));
});

test("interactive sync warns with the check's findings after a fallback, before the push", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": `${skillMd("hello")}Call the Skill tool with "other".\n` });
  edit(world, clone, { "SKILL.md": wording("hello", "My wording.") });

  const result = await world.run(["sync"], { answers: ["fallback", "yes"] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout.indexOf("Warning: the workflow check")).toBeGreaterThan(result.stdout.indexOf("Fell back: hello."));
  expect(result.stdout.indexOf("Warning: the workflow check")).toBeLessThan(result.stdout.indexOf("Pushed."));
});
