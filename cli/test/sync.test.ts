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
  return { world, source, clone, pin: source.head() };
}

const logOf = (world: World, clone: string) => world.git(["log", "--format=%an <%ae>|%s"], clone).split("\n");

test("status fetches the source and lists only the skills with changes since their pin", async () => {
  const { world, source } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": `${skillMd("hello")}More.\n` }, "Teach hello more");
  source.commit({ "skills/hello/extra.md": "extra\n" }, "Add extra to hello");

  const result = await world.run(["sync", "status"], { cwd: world.project });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("hello: 2 commits");
  expect(result.stdout).not.toContain("other");
  expect(result.stdout).toContain("Next: run `moro sync show hello`");
});

test("status says everything is up to date when nothing changed upstream", async () => {
  const { world } = await setWithTools();
  const result = await world.run(["sync", "status"]);
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Up to date.");
});

test("show prints the diff with rename rules on both sides, commit subjects, changesets and the hand-edit flag", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/hello/SKILL.md": `${skillMd("hello")}Ask Acme.\n` });
  const clone = world.cloneSet();
  world.recordClone(clone);
  expect((await world.run(["add", source.url, "hello", "--yes"], { cwd: clone })).code).toBe(0);
  const manifest = readManifest(clone);
  manifest.sources.tools.rename = [["Acme", "Moro"]];
  writeFileSync(join(clone, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(clone, "skills/misc/hello/SKILL.md"), `${skillMd("hello")}Ask Moro.\n`);
  world.git(["commit", "-qam", "rules"], clone);
  source.commit(
    {
      "skills/hello/SKILL.md": `${skillMd("hello")}Ask Acme.\nAcme says more.\n`,
      ".changeset/brave-owls.md": '---\n"tools": minor\n---\n\nHello learns what Acme thinks.\n',
    },
    "Hello says more",
  );

  const result = await world.run(["sync", "show", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("+Moro says more.");
  expect(result.stdout).not.toContain("Acme says");
  expect(result.stdout).toContain("Hello says more");
  expect(result.stdout).toContain("Hello learns what Moro thinks.");
  expect(result.stdout).toContain("Hand edits: none");
  expect(world.git(["status", "--porcelain"], clone)).toBe("");

  writeFileSync(join(clone, "skills/misc/hello/SKILL.md"), `${skillMd("hello")}Ask Moro.\nMine.\n`);
  const edited = await world.run(["sync", "show", "hello"]);
  expect(edited.stdout).toContain("Hand edits: SKILL.md");
});

test("accept takes the change, keeps a hand edit that doesn't conflict, moves the pin and makes one commit", async () => {
  const { world, source, clone } = await setWithTools({ "skills/hello/notes.md": "one\ntwo\nthree\nfour\nfive\n" });
  const head = source.commit({ "skills/hello/notes.md": "one\ntwo\nthree\nfour\nFIVE\n", "skills/hello/new.md": "new\n" }, "Change notes");
  const notes = join(clone, "skills/misc/hello/notes.md");
  writeFileSync(notes, "ONE\ntwo\nthree\nfour\nfive\n");
  world.git(["commit", "-qam", "my edit"], clone);

  const result = await world.run(["sync", "accept", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(notes, "utf8")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
  expect(readFileSync(join(clone, "skills/misc/hello/new.md"), "utf8")).toBe("new\n");
  expect(readManifest(clone).skills.hello).toEqual({ source: "tools", path: "skills/hello", pin: head, skipped: [] });
  expect(logOf(world, clone).slice(0, 2)).toEqual([`${SET_IDENTITY}|sync: accept hello`, `${SET_IDENTITY}|my edit`]);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
  expect((await world.run(["sync", "status"])).stdout).toContain("Up to date.");
});

test("accept that would conflict changes nothing", async () => {
  const { world, source, clone, pin } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": skillMd("hello").replace("The hello skill.", "Upstream wording.") });
  const file = join(clone, "skills/misc/hello/SKILL.md");
  writeFileSync(file, skillMd("hello").replace("The hello skill.", "My wording."));
  world.git(["commit", "-qam", "my edit"], clone);

  const result = await world.run(["sync", "accept", "hello"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("conflict");
  expect(readFileSync(file, "utf8")).toContain("My wording.");
  expect(readManifest(clone).skills.hello.pin).toBe(pin);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("skip keeps the copy, moves the pin, records the commits as skipped and doesn't offer the change again", async () => {
  const { world, source, clone } = await setWithTools();
  const first = source.commit({ "skills/hello/a.md": "a\n" }, "First");
  const second = source.commit({ "skills/hello/b.md": "b\n" }, "Second");
  const before = world.git(["rev-parse", "HEAD:skills/misc/hello"], clone);

  const result = await world.run(["sync", "skip", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(world.git(["rev-parse", "HEAD:skills/misc/hello"], clone)).toBe(before);
  const entry = readManifest(clone).skills.hello;
  expect(entry.pin).toBe(source.head());
  expect(entry.skipped).toEqual([first, second]);
  expect(logOf(world, clone)[0]).toBe(`${SET_IDENTITY}|sync: skip hello`);
  expect((await world.run(["sync", "status"])).stdout).toContain("Up to date.");
});

test("a skill left undecided records nothing and shows up again", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/a.md": "a\n" });
  const commits = world.git(["rev-list", "--count", "HEAD"], clone);
  await world.run(["sync", "status"]);
  await world.run(["sync", "show", "hello"]);
  expect(world.git(["rev-list", "--count", "HEAD"], clone)).toBe(commits);
  expect((await world.run(["sync", "status"])).stdout).toContain("hello: 1 commit");
});

test("sync works from any folder and names skills it doesn't know", async () => {
  const { world } = await setWithTools();
  const result = await world.run(["sync", "accept", "nope"], { cwd: world.home });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("nope is not an upstream skill");
});
