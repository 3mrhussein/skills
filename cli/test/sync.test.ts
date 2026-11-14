import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const markers = (text: string) => /^<<<<<<< /m.test(text);

test("a conflicting accept leaves diff3 markers, moves the pin and holds the commit until they are gone", async () => {
  const { world, source, clone } = await setWithTools();
  const head = source.commit({ "skills/hello/SKILL.md": skillMd("hello").replace("The hello skill.", "Upstream wording.") });
  const file = join(clone, "skills/misc/hello/SKILL.md");
  writeFileSync(file, skillMd("hello").replace("The hello skill.", "My wording."));
  world.git(["commit", "-qam", "my edit"], clone);
  const commits = world.git(["rev-list", "--count", "HEAD"], clone);

  const accepted = await world.run(["sync", "accept", "hello"]);

  expect(accepted.code).toBe(1);
  expect(accepted.stdout).toContain("SKILL.md");
  expect(accepted.stdout).toContain("conflict");
  const text = readFileSync(file, "utf8");
  expect(markers(text)).toBe(true);
  expect(text).toContain("||||||| at the pin");
  expect(readManifest(clone).skills.hello.pin).toBe(head);
  expect(world.git(["rev-list", "--count", "HEAD"], clone)).toBe(commits);

  const blocked = await world.run(["sync", "accept", "hello"]);
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toContain("SKILL.md");
  expect(world.git(["rev-list", "--count", "HEAD"], clone)).toBe(commits);

  writeFileSync(file, skillMd("hello").replace("The hello skill.", "Both wordings."));
  const done = await world.run(["sync", "accept", "hello"]);
  expect(done.code, done.stderr).toBe(0);
  expect(logOf(world, clone)[0]).toBe(`${SET_IDENTITY}|sync: accept hello`);
  expect(readFileSync(file, "utf8")).toContain("Both wordings.");
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("a held conflict doesn't block deciding other skills, and each commit leaves the held pin out", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": skillMd("hello").replace("The hello skill.", "Upstream wording.") });
  const otherHead = source.commit({ "skills/other/extra.md": "extra\n" });
  const pin = readManifest(clone).skills.hello.pin;
  const file = join(clone, "skills/misc/hello/SKILL.md");
  writeFileSync(file, skillMd("hello").replace("The hello skill.", "My wording."));
  world.git(["commit", "-qam", "my edit"], clone);
  expect((await world.run(["sync", "accept", "hello"])).code).toBe(1);

  const other = await world.run(["sync", "accept", "other"]);

  expect(other.code, other.stderr).toBe(0);
  expect(logOf(world, clone)[0]).toBe(`${SET_IDENTITY}|sync: accept other`);
  expect(JSON.parse(world.git(["show", "HEAD:manifest.json"], clone)).skills).toMatchObject({ hello: { pin }, other: { pin: otherHead } });
  expect(readManifest(clone).skills.hello.pin).toBe(otherHead);
  expect(markers(readFileSync(file, "utf8"))).toBe(true);

  writeFileSync(file, skillMd("hello").replace("The hello skill.", "Both wordings."));
  expect((await world.run(["sync", "accept", "hello"])).code).toBe(0);
  expect(JSON.parse(world.git(["show", "HEAD:manifest.json"], clone)).skills.hello.pin).toBe(otherHead);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("show flags a conflict on accept", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": skillMd("hello").replace("The hello skill.", "Upstream wording.") });
  writeFileSync(join(clone, "skills/misc/hello/SKILL.md"), skillMd("hello").replace("The hello skill.", "My wording."));
  world.git(["commit", "-qam", "my edit"], clone);
  expect((await world.run(["sync", "show", "hello"])).stdout).toContain("Accept would conflict in: SKILL.md");
});

test("status lists a pure move and changes nothing; a decision or interactive sync then follows it without asking", async () => {
  const { world, source, clone } = await setWithTools();
  const head = source.commit({ "skills/engineering/hello/SKILL.md": skillMd("hello") }, "Move hello", ["skills/hello"]);
  const before = world.git(["rev-parse", "HEAD:skills/misc/hello"], clone);
  const commits = world.git(["rev-list", "--count", "HEAD"], clone);

  const status = await world.run(["sync", "status"]);

  expect(status.code, status.stderr).toBe(0);
  expect(status.stdout).toContain("hello: moved, no change to the files");
  expect(world.git(["rev-list", "--count", "HEAD"], clone)).toBe(commits);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");

  const result = await world.run(["sync"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Up to date.");
  expect(readManifest(clone).skills.hello).toMatchObject({ path: "skills/engineering/hello", pin: head });
  expect(world.git(["rev-parse", "HEAD:skills/misc/hello"], clone)).toBe(before);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
  expect(logOf(world, clone)[0]).toBe(`${SET_IDENTITY}|sync: follow move of hello`);
});

test("a move with changes follows the skill by its upstream name and show flags the move", async () => {
  const { world, source, clone } = await setWithTools();
  const head = source.commit(
    { "skills/engineering/hello/SKILL.md": `${skillMd("hello")}More.\n` },
    "Move and change hello",
    ["skills/hello"],
  );

  const shown = await world.run(["sync", "show", "hello"]);
  expect(shown.stdout).toContain("Moved: skills/hello to skills/engineering/hello");
  expect(shown.stdout).toContain("+More.");

  const result = await world.run(["sync", "accept", "hello"]);
  expect(result.code, result.stderr).toBe(0);
  expect(readManifest(clone).skills.hello).toMatchObject({ path: "skills/engineering/hello", pin: head });
  expect(readFileSync(join(clone, "skills/misc/hello/SKILL.md"), "utf8")).toContain("More.");
});

async function setWithGraph() {
  const made = await setWithTools();
  const manifest = readManifest(made.clone);
  manifest.recommended = ["skills/misc/hello", "skills/misc/other"];
  manifest.required = ["skills/misc/hello"];
  manifest.dependsOn = { other: ["hello"], hello: ["other"] };
  writeFileSync(join(made.clone, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  made.world.git(["commit", "-qam", "graph"], made.clone);
  made.source.commit({}, "Remove hello", ["skills/hello"]);
  return made;
}

test("a skill removed upstream is deleted on accept and dropped from recommended, required and dependsOn", async () => {
  const { world, clone } = await setWithGraph();

  const status = await world.run(["sync", "status"]);
  expect(status.stdout).toContain("hello: removed upstream");
  expect((await world.run(["sync", "show", "hello"])).stdout).toContain("Removed upstream");

  const result = await world.run(["sync", "accept", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  const manifest = readManifest(clone);
  expect(manifest.skills.hello).toBeUndefined();
  expect(manifest.recommended).toEqual(["skills/misc/other"]);
  expect(manifest.required).toEqual([]);
  expect(manifest.dependsOn).toEqual({ other: [] });
  expect(existsSync(join(clone, "skills/misc/hello"))).toBe(false);
  expect(logOf(world, clone)[0]).toBe(`${SET_IDENTITY}|sync: accept hello`);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("skipping a removal deletes only the manifest entry, so the skill stays as an own skill", async () => {
  const { world, clone } = await setWithGraph();

  const result = await world.run(["sync", "skip", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  const manifest = readManifest(clone);
  expect(manifest.skills.hello).toBeUndefined();
  expect(manifest.recommended).toContain("skills/misc/hello");
  expect(existsSync(join(clone, "skills/misc/hello/SKILL.md"))).toBe(true);
  expect(logOf(world, clone)[0]).toBe(`${SET_IDENTITY}|sync: skip hello`);
  expect((await world.run(["sync", "status"])).stdout).toContain("Up to date.");
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

test("skills new in a source are listed as an FYI and never added", async () => {
  const { world, source, clone } = await setWithTools();
  source.commit({ "skills/fresh/SKILL.md": skillMd("fresh") }, "Add fresh");

  const result = await world.run(["sync", "status"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Up to date.");
  expect(result.stdout).toMatch(/New upstream skills[^\n]*\n\s+tools: fresh/);
  expect(Object.keys(readManifest(clone).skills)).toEqual(["hello", "other"]);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("new lines naming Matt that no rule covers are a warning only", async () => {
  const { world, source } = await setWithTools();
  source.commit({ "skills/hello/SKILL.md": `${skillMd("hello")}Thanks to Matt for this.\n` }, "Credit");

  const status = await world.run(["sync", "status"]);
  expect(status.code, status.stderr).toBe(0);
  expect(status.stdout).toContain("hello: 1 commit, new lines naming Matt");

  const shown = await world.run(["sync", "show", "hello"]);
  expect(shown.code, shown.stderr).toBe(0);
  expect(shown.stdout).toContain("Warning");
  expect(shown.stdout).toContain("SKILL.md: Thanks to Matt for this.");

  expect((await world.run(["sync", "accept", "hello"])).code).toBe(0);
});

test("an unreachable source is reported and left undecided while other sources still sync", async () => {
  const { world, source, clone } = await setWithTools();
  const other = world.source("acme/more", { "skills/extra/SKILL.md": skillMd("extra") });
  expect((await world.run(["add", other.url, "extra", "--yes"], { cwd: clone })).code).toBe(0);
  source.commit({ "skills/hello/a.md": "a\n" });
  other.commit({ "skills/extra/b.md": "b\n" });
  rmSync(source.bare, { recursive: true, force: true });

  const status = await world.run(["sync", "status"]);

  expect(status.code).toBe(1);
  expect(status.stderr).toContain("Can't reach tools");
  expect(status.stderr).toContain("left undecided");
  expect(status.stdout).toContain("extra: 1 commit");
  expect(status.stdout).not.toContain("hello:");
  expect((await world.run(["sync", "accept", "extra"])).code).toBe(0);
  expect((await world.run(["sync", "accept", "hello"])).code).toBe(1);
});

test("changing a source's rename rules re-renders its skills at the same pin without making hand edits", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/hello/SKILL.md": `${skillMd("hello")}Ask Acme.\nAcme again.\n` });
  const clone = world.cloneSet();
  world.recordClone(clone);
  expect((await world.run(["add", source.url, "hello", "--yes"], { cwd: clone })).code).toBe(0);
  const file = join(clone, "skills/misc/hello/SKILL.md");
  writeFileSync(file, `Mine.\n${readFileSync(file, "utf8")}`);
  world.git(["commit", "-qam", "my edit"], clone);
  const pin = readManifest(clone).skills.hello.pin;
  const manifest = readManifest(clone);
  manifest.sources.tools.rename = [["Acme", "Moro"]];
  writeFileSync(join(clone, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  world.git(["commit", "-qam", "new rule"], clone);
  const headBefore = world.git(["rev-parse", "HEAD"], clone);

  const status = await world.run(["sync", "status"]);
  expect(status.code, status.stderr).toBe(0);
  expect(status.stdout).toContain("tools: rename rules changed");
  expect(world.git(["rev-parse", "HEAD"], clone)).toBe(headBefore);

  const result = await world.run(["sync"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Up to date.");
  expect(readFileSync(file, "utf8")).toBe(`Mine.\n${skillMd("hello")}Ask Moro.\nMoro again.\n`);
  expect(readManifest(clone).skills.hello.pin).toBe(pin);
  expect(logOf(world, clone)[0]).toBe(`${SET_IDENTITY}|sync: re-render tools`);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");

  source.commit({ "skills/hello/SKILL.md": `${skillMd("hello")}Ask Acme.\nAcme again.\nAcme more.\n` });
  const shown = await world.run(["sync", "show", "hello"]);
  expect(shown.stdout).toContain("Hand edits: SKILL.md");
  expect(shown.stdout).toContain("+Moro more.");
  const commits = world.git(["rev-list", "--count", "HEAD"], clone);
  await world.run(["sync"], { answers: ["later"] });
  expect(world.git(["rev-list", "--count", "HEAD"], clone)).toBe(commits);
});

test("sync works from any folder and names skills it doesn't know", async () => {
  const { world } = await setWithTools();
  const result = await world.run(["sync", "accept", "nope"], { cwd: world.home });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain("nope is not an upstream skill");
});

test("a re-render blocked by uncommitted changes names bare `moro sync` as the rerun", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/hello/SKILL.md": `${skillMd("hello")}Ask Acme.\n` });
  const clone = world.cloneSet();
  world.recordClone(clone);
  expect((await world.run(["add", source.url, "hello", "--yes"], { cwd: clone })).code).toBe(0);
  const manifest = readManifest(clone);
  manifest.sources.tools.rename = [["Acme", "Moro"]];
  writeFileSync(join(clone, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  world.git(["commit", "-qam", "new rule"], clone);
  const file = join(clone, "skills/misc/hello/SKILL.md");
  writeFileSync(file, `Mine.\n${readFileSync(file, "utf8")}`);

  const result = await world.run(["sync"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Next: commit or discard them, then rerun `moro sync`.");
  expect(readFileSync(file, "utf8")).toBe(`Mine.\n${skillMd("hello")}Ask Acme.\n`);
});
