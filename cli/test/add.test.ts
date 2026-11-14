import { chmodSync, existsSync, lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, readManifest, SET_IDENTITY, skillMd, type World, writeFiles } from "./world.js";

function log(world: World, clone: string): string[] {
  return world.git(["log", "--format=%an <%ae>|%s%n%b"], clone).split("\n").filter(Boolean);
}

test("intake copies the source's skill folder into skills/, writes the manifest and makes one commit", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", {
    "skills/hello/SKILL.md": skillMd("hello"),
    "skills/hello/references/notes.md": "Some notes.\n",
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", source.url, "hello", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(join(clone, "skills/hello/SKILL.md"), "utf8")).toBe(skillMd("hello"));
  expect(readFileSync(join(clone, "skills/hello/references/notes.md"), "utf8")).toBe("Some notes.\n");
  expect(readManifest(clone)).toEqual({
    moro: "0.1.0",
    sources: { tools: { repo: source.url, rename: [] } },
    skills: { hello: { source: "tools", path: "skills/hello", pin: source.head(), skipped: [] } },
  });
  expect(log(world, clone)).toEqual([`${SET_IDENTITY}|add: tools hello`, `world <world@moro.test>|initial`]);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test.each([
  ["owner/repo with the skill named", ["acme/tools", "hello"]],
  ["owner/repo@skill", ["acme/tools@hello"]],
  ["a GitHub tree URL to the skill's folder", ["https://github.com/acme/tools/tree/main/skills/hello"]],
  ["a GitHub URL with the skill named", ["https://github.com/acme/tools", "hello"]],
])("a GitHub source given as %s is recorded by its owner/repo shorthand", async (_form, refArgs) => {
  const world = createWorld();
  const source = world.source("acme/tools", {
    "skills/hello/SKILL.md": skillMd("hello"),
    "skills/other/SKILL.md": skillMd("other"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", ...refArgs, "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  const manifest = readManifest(clone);
  expect(manifest.sources).toEqual({ tools: { repo: "acme/tools", rename: [] } });
  expect(manifest.skills).toEqual({
    hello: { source: "tools", path: "skills/hello", pin: source.head(), skipped: [] },
  });
});

test.each([
  ["a commit", (first: string) => first],
  ["a tag", () => "v1"],
])("#ref pins %s instead of the default branch's HEAD", async (_kind, refFor) => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const first = source.head();
  source.tag("v1");
  source.commit({ "skills/hello/SKILL.md": `${skillMd("hello")}Newer.\n` });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", `acme/tools#${refFor(first)}`, "hello", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(readManifest(clone).skills.hello.pin).toBe(first);
  expect(readFileSync(join(clone, "skills/hello/SKILL.md"), "utf8")).toBe(skillMd("hello"));
});

test("#ref pins the latest commit of a branch other than the default one", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const onBranch = source.branch("next", { "skills/hello/SKILL.md": `${skillMd("hello")}Next.\n` });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools#next@hello", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(readManifest(clone).skills.hello.pin).toBe(onBranch);
});

test("the key is the frontmatter name, while path keeps the source's own folder", async () => {
  const world = createWorld();
  world.source("vercel/agent-skills", {
    "skills/react-best-practices/SKILL.md": skillMd("vercel-react-best-practices"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "vercel/agent-skills", "vercel-react-best-practices", "--yes"], {
    cwd: clone,
  });

  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(join(clone, "skills/vercel-react-best-practices/SKILL.md"), "utf8")).toBe(
    skillMd("vercel-react-best-practices"),
  );
  expect(readManifest(clone).skills["vercel-react-best-practices"]).toMatchObject({
    source: "agent-skills",
    path: "skills/react-best-practices",
  });
});

test("--work puts the skill in work/ and the manifest entry looks the same", async () => {
  const world = createWorld();
  const source = world.source("company/work", { "skills/deploy/SKILL.md": skillMd("deploy") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "company/work", "deploy", "--work", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(join(clone, "work/deploy/SKILL.md"), "utf8")).toBe(skillMd("deploy"));
  expect(existsSync(join(clone, "skills/deploy"))).toBe(false);
  expect(readManifest(clone).skills.deploy).toEqual({
    source: "work",
    path: "skills/deploy",
    pin: source.head(),
    skipped: [],
  });
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

function manifestWith(sources: Record<string, { repo: string; rename: [string, string][] }>): string {
  return `${JSON.stringify({ moro: "0.1.0", sources, skills: {} }, null, 2)}\n`;
}

test("a new source whose repo name is taken gets owner-repo as its id", async () => {
  const world = createWorld({ set: { "manifest.json": manifestWith({ tools: { repo: "other/tools", rename: [] } }) } });
  world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "hello", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  const manifest = readManifest(clone);
  expect(manifest.sources).toEqual({
    tools: { repo: "other/tools", rename: [] },
    "acme-tools": { repo: "acme/tools", rename: [] },
  });
  expect(manifest.skills.hello.source).toBe("acme-tools");
  expect(log(world, clone)[0]).toBe(`${SET_IDENTITY}|add: acme-tools hello`);
});

test("a source already in the manifest keeps its id and its rename rules", async () => {
  const rules: [string, string][] = [["ask-acme", "ask-moro"]];
  const world = createWorld({ set: { "manifest.json": manifestWith({ acme: { repo: "acme/tools", rename: rules } }) } });
  world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "https://github.com/acme/tools", "hello", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  const manifest = readManifest(clone);
  expect(manifest.sources).toEqual({ acme: { repo: "acme/tools", rename: rules } });
  expect(manifest.skills.hello.source).toBe("acme");
});

test("rename rules apply in order and whole-word to text and file names, and the key follows them", async () => {
  const rules: [string, string][] = [
    ["ask-matt", "ask-moro"],
    ["Matt Pocock's", "moro's"],
    ["GLOSSARY.md", "CONTEXT.md"],
    ["matt", "moro"],
  ];
  const world = createWorld({ set: { "manifest.json": manifestWith({ matt: { repo: "mattpocock/skills", rename: rules } }) } });
  world.source("mattpocock/skills", {
    "skills/engineering/ask-matt/SKILL.md": [
      "---",
      "name: ask-matt",
      "description: Matt Pocock's router. Put matt in the frontmatter, whatever the formatting.",
      "---",
      "",
      "Ask matt. Read GLOSSARY.md, then run /ask-matt. It matters.",
      "",
    ].join("\n"),
    "skills/engineering/ask-matt/GLOSSARY.md": "Words matt uses.\n",
    "skills/engineering/ask-matt/matt-notes/matters.md": "Unchanged name.\n",
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "mattpocock/skills", "ask-matt", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  const folder = join(clone, "skills/ask-moro");
  expect(readFileSync(join(folder, "SKILL.md"), "utf8")).toBe(
    [
      "---",
      "name: ask-moro",
      "description: moro's router. Put moro in the frontmatter, whatever the formatting.",
      "---",
      "",
      "Ask moro. Read CONTEXT.md, then run /ask-moro. It matters.",
      "",
    ].join("\n"),
  );
  expect(readFileSync(join(folder, "CONTEXT.md"), "utf8")).toBe("Words moro uses.\n");
  expect(readFileSync(join(folder, "moro-notes/matters.md"), "utf8")).toBe("Unchanged name.\n");
  expect(existsSync(join(folder, "GLOSSARY.md"))).toBe(false);
  expect(readManifest(clone).skills).toEqual({
    "ask-moro": { source: "matt", path: "skills/engineering/ask-matt", pin: expect.any(String), skipped: [] },
  });
});

test("intake takes every file verbatim: licences, tool metadata, hidden and binary files", async () => {
  const rules: [string, string][] = [["matt", "moro"]];
  const world = createWorld({ set: { "manifest.json": manifestWith({ matt: { repo: "mattpocock/skills", rename: rules } }) } });
  const binary = "PNG\u0000matt\u0000";
  world.source("mattpocock/skills", {
    "tdd/SKILL.md": skillMd("tdd"),
    "tdd/LICENSE.txt": "Apache License 2.0\n",
    "tdd/agents/openai.yaml": "interface:\n  display_name: TDD\n",
    "tdd/metadata.json": '{ "version": "1.0.0" }\n',
    "tdd/.hidden": "kept\n",
    "tdd/logo.png": binary,
    "tdd/scripts/run.sh": "#!/bin/sh\necho hi\n",
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "mattpocock/skills", "tdd", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  const files = world.git(["ls-files", "skills/tdd"], clone).split("\n").sort();
  expect(files).toEqual([
    "skills/tdd/.hidden",
    "skills/tdd/LICENSE.txt",
    "skills/tdd/SKILL.md",
    "skills/tdd/agents/openai.yaml",
    "skills/tdd/logo.png",
    "skills/tdd/metadata.json",
    "skills/tdd/scripts/run.sh",
  ]);
  expect(readFileSync(join(clone, "skills/tdd/logo.png"), "utf8")).toBe(binary);
});

test("several skills from one source make one commit, and own skills get no manifest entry", async () => {
  const world = createWorld({ set: { "skills/mine/SKILL.md": skillMd("mine") } });
  world.source("acme/tools", {
    "skills/one/SKILL.md": skillMd("one"),
    "skills/two/SKILL.md": skillMd("two"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);
  // The lock is never read, so a broken one changes nothing.
  writeFiles(world.home, { ".agents/.skill-lock.json": "not json" });

  const result = await world.run(["add", "acme/tools", "one", "two", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(Object.keys(readManifest(clone).skills)).toEqual(["one", "two"]);
  expect(log(world, clone)).toEqual([`${SET_IDENTITY}|add: tools one two`, `world <world@moro.test>|initial`]);
  expect(result.stdout).toContain(
    "Added one, two from tools in one commit.\nPushed.\n\nNext: run `moro refresh` on each machine that should have them.\n",
  );
});

test("the commit takes only intake's files, leaving the owner's other changes as they were", async () => {
  const world = createWorld({ set: { "README.md": "Old.\n" } });
  world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);
  writeFiles(clone, { "README.md": "New.\n", "notes.md": "Draft.\n" });
  world.git(["add", "README.md"], clone);

  const result = await world.run(["add", "acme/tools", "hello", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(world.git(["show", "--name-only", "--format=", "HEAD"], clone).split("\n")).toEqual([
    "manifest.json",
    "skills/hello/SKILL.md",
  ]);
  expect(world.git(["status", "--porcelain"], clone)).toBe("M  README.md\n?? notes.md".trim());
});

test("without a repo-level git identity, intake stops before changing anything", async () => {
  const world = createWorld();
  world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet({ identity: false });
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "hello", "--yes"], { cwd: clone });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("The set's clone has no git identity of its own");
  expect(result.stderr).toContain('git config user.email "<your personal email>"');
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
  expect(log(world, clone)).toHaveLength(1);
});

test.each([["skills"], ["work"]])("a skill whose name is already in %s/ stops intake", async (folder) => {
  const world = createWorld({ set: { [`${folder}/hello/SKILL.md`]: skillMd("hello") } });
  world.source("acme/tools", { "skills/hello/SKILL.md": `${skillMd("hello")}Theirs.\n` });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "hello", "--yes"], { cwd: clone });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`hello is already in the set (${folder}/hello).`);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
  expect(log(world, clone)).toHaveLength(1);
});

test("an option add doesn't know stops it", async () => {
  const world = createWorld();
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "hello", "--yes", "--force"], { cwd: clone });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unknown option: --force");
});

test("two skills that render to the same key stop intake", async () => {
  const world = createWorld({
    set: { "manifest.json": manifestWith({ matt: { repo: "mattpocock/skills", rename: [["matt", "moro"]] } }) },
  });
  world.source("mattpocock/skills", {
    "a/SKILL.md": skillMd("matt-tdd"),
    "b/SKILL.md": skillMd("moro-tdd"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "mattpocock/skills", "matt-tdd", "moro-tdd", "--yes"], { cwd: clone });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("matt-tdd and moro-tdd would both be moro-tdd in the set.");
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("when the commit fails, intake leaves the set's clone as it was", async () => {
  const world = createWorld({ set: { "manifest.json": manifestWith({}) } });
  world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);
  writeFiles(clone, { ".git/hooks/pre-commit": "#!/bin/sh\nexit 1\n" });
  chmodSync(join(clone, ".git/hooks/pre-commit"), 0o755);

  const result = await world.run(["add", "acme/tools", "hello", "--yes"], { cwd: clone });

  expect(result.code).not.toBe(0);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
  expect(log(world, clone)).toHaveLength(1);
});

test("intake keeps file modes and symlinks", async () => {
  const world = createWorld({
    set: { "manifest.json": manifestWith({ matt: { repo: "mattpocock/skills", rename: [["matt", "moro"]] } }) },
  });
  world.source("mattpocock/skills", {
    "tdd/SKILL.md": skillMd("tdd"),
    "tdd/scripts/run.sh": { content: "#!/bin/sh\necho hi\n", mode: 0o755 },
    "tdd/notes.md": "Shared notes.\n",
    "tdd/link.md": { symlink: "notes.md" },
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "mattpocock/skills", "tdd", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(statSync(join(clone, "skills/tdd/scripts/run.sh")).mode & 0o111).not.toBe(0);
  expect(lstatSync(join(clone, "skills/tdd/link.md")).isSymbolicLink()).toBe(true);
  expect(readlinkSync(join(clone, "skills/tdd/link.md"))).toBe("notes.md");
});

test("a file that isn't UTF-8 keeps its bytes", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const bytes = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café" in Latin-1
  source.commit({ "skills/hello/latin1.txt": { content: bytes } });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "hello", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(join(clone, "skills/hello/latin1.txt"))).toEqual(bytes);
});

test("a GitHub SSH URL is the same source as its owner/repo shorthand", async () => {
  const world = createWorld({
    set: { "manifest.json": manifestWith({ matt: { repo: "mattpocock/skills", rename: [["ask-matt", "ask-moro"]] } }) },
  });
  world.source("mattpocock/skills", { "skills/ask-matt/SKILL.md": skillMd("ask-matt") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "git@github.com:mattpocock/skills.git", "ask-matt", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(Object.keys(readManifest(clone).sources)).toEqual(["matt"]);
  expect(readManifest(clone).skills["ask-moro"].source).toBe("matt");
});

test("owner/repo@skill and named skills add up, and a name given twice is taken once", async () => {
  const world = createWorld();
  world.source("acme/tools", {
    "skills/hello/SKILL.md": skillMd("hello"),
    "skills/other/SKILL.md": skillMd("other"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools@hello", "other", "hello", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(Object.keys(readManifest(clone).skills)).toEqual(["hello", "other"]);
  expect(log(world, clone)[0]).toBe(`${SET_IDENTITY}|add: tools hello other`);
});
