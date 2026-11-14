import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, readManifest, SET_IDENTITY, skillMd, type World, writeFiles } from "./world.js";

function subjects(world: World, clone: string): string[] {
  return world.git(["log", "--format=%an <%ae>|%s"], clone).split("\n");
}

/** The SHA the set's remote has on main. */
function remoteHead(world: World): string {
  return world.git(["ls-remote", world.set.url, "refs/heads/main"], world.root).split("\t")[0]!;
}

function manifestWith(
  sources: Record<string, { repo: string; rename: [string, string][] }>,
  skills: Record<string, { source: string; path: string; pin: string; skipped: string[] }> = {},
): string {
  return `${JSON.stringify({ moro: "0.1.0", sources, skills }, null, 2)}\n`;
}

test("with no skill named, add picks from the source, asks each key, group, recommended and dependencies, then pushes", async () => {
  const world = createWorld({
    set: {
      "manifest.json": manifestWith(
        { tools: { repo: "acme/tools", rename: [] } },
        { how: { source: "tools", path: "skills/how", pin: "0".repeat(40), skipped: [] } },
      ),
      "skills/eng/how/SKILL.md": skillMd("how"),
    },
  });
  const source = world.source("acme/tools", {
    "skills/arena/SKILL.md": skillMd("arena"),
    "skills/how/SKILL.md": skillMd("how"),
    "skills/tdd/SKILL.md": skillMd("tdd"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools"], {
    cwd: clone,
    answers: [["skills/arena", "skills/tdd"], "each", "arena", "tdd", "misc", "misc", "no", [], [], "yes"],
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([
    {
      message: "Which skills from acme/tools?",
      choices: [
        { value: "skills/arena", label: "arena" },
        { value: "skills/how", label: "how", disabled: "already in the set as how" },
        { value: "skills/tdd", label: "tdd" },
      ],
    },
    expect.objectContaining({ message: "Keys in the set for these 2 skills?", recommended: "names" }),
    expect.objectContaining({ message: "Key for arena in the set?", recommended: "arena", allowTyped: "another key" }),
    expect.objectContaining({ message: "Key for tdd in the set?", recommended: "tdd" }),
    expect.objectContaining({ message: "Group for arena in the set?", recommended: "misc" }),
    expect.objectContaining({ message: "Group for tdd in the set?", recommended: "misc" }),
    expect.objectContaining({ message: "Are arena, tdd recommended?", recommended: "no" }),
    expect.objectContaining({ message: "Which set skills does arena depend on?" }),
    expect.objectContaining({ message: "Which set skills does tdd depend on?" }),
    expect.objectContaining({ message: "Push now?", recommended: "yes" }),
  ]);
  expect(readManifest(clone).skills).toMatchObject({
    arena: { source: "tools", path: "skills/arena", pin: source.head() },
    tdd: { source: "tools", path: "skills/tdd", pin: source.head() },
  });
  expect(subjects(world, clone)[0]).toBe(`${SET_IDENTITY}|add: tools arena tdd`);
  expect(remoteHead(world)).toBe(world.git(["rev-parse", "HEAD"], clone));
  expect(result.stdout).toContain(
    "Added arena, tdd from tools in one commit.\nPushed.\n\nNext: run /setup-moro-skills in each project that should get them.\n",
  );
});

test("--all takes every skill not already in the set, and --yes asks nothing and pushes", async () => {
  const world = createWorld({
    set: {
      "manifest.json": manifestWith(
        { tools: { repo: "acme/tools", rename: [] } },
        { how: { source: "tools", path: "skills/how", pin: "0".repeat(40), skipped: [] } },
      ),
      "skills/eng/how/SKILL.md": skillMd("how"),
    },
  });
  world.source("acme/tools", {
    "skills/arena/SKILL.md": skillMd("arena"),
    "skills/how/SKILL.md": skillMd("how"),
    "skills/tdd/SKILL.md": skillMd("tdd"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "--all", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(Object.keys(readManifest(clone).skills)).toEqual(["arena", "how", "tdd"]);
  expect(remoteHead(world)).toBe(world.git(["rev-parse", "HEAD"], clone));
});

test("--all with nothing new adds nothing", async () => {
  const world = createWorld({
    set: {
      "manifest.json": manifestWith(
        { tools: { repo: "acme/tools", rename: [] } },
        { how: { source: "tools", path: "skills/how", pin: "0".repeat(40), skipped: [] } },
      ),
      "skills/eng/how/SKILL.md": skillMd("how"),
    },
  });
  world.source("acme/tools", { "skills/how/SKILL.md": skillMd("how") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "--all"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    "Nothing was added. Every skill in acme/tools is already in the set.\n\nNext: run `moro sync` to take their upstream changes.\n",
  );
  expect(subjects(world, clone)).toHaveLength(1);
});

test("picking nothing adds nothing and asks nothing more", async () => {
  const world = createWorld();
  world.source("acme/tools", { "skills/arena/SKILL.md": skillMd("arena") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools"], { cwd: clone, answers: [[]] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Nothing was added.\n\nNext: run `moro add acme/tools` to pick again.\n");
  expect(subjects(world, clone)).toHaveLength(1);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("the owner can type another key, and a key that isn't a skill name is asked again", async () => {
  const world = createWorld();
  world.source("vercel/agent-skills", {
    "skills/react-best-practices/SKILL.md": skillMd("vercel-react-best-practices"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "vercel/agent-skills", "vercel-react-best-practices"], {
    cwd: clone,
    answers: [{ typed: "React Rules" }, { typed: "react-rules" }, "misc", "no", "yes"],
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("React Rules can't be a key: use lowercase letters, digits and hyphens.");
  expect(readFileSync(join(clone, "skills/misc/react-rules/SKILL.md"), "utf8")).toBe(
    skillMd("vercel-react-best-practices").replace("name: vercel-react-best-practices", "name: react-rules"),
  );
  expect(readManifest(clone).skills).toEqual({
    "react-rules": {
      source: "agent-skills",
      path: "skills/react-best-practices",
      pin: expect.any(String),
      skipped: [],
    },
  });
  // A key chosen at the prompt is not a clash, so the source gets no rule.
  expect(readManifest(clone).sources["agent-skills"].rename).toEqual([]);
});

test("a key clashing with the set: keeping the set's skill adds nothing from the source", async () => {
  const world = createWorld({ set: { "skills/eng/tdd/SKILL.md": skillMd("tdd") } });
  world.source("poteto/pstack", { "skills/tdd/SKILL.md": `${skillMd("tdd")}Theirs.\n` });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "poteto/pstack", "tdd"], { cwd: clone, answers: ["tdd", "keep"] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[1]).toEqual({
    message: "tdd is already in the set (skills/eng/tdd). Keep which?",
    choices: [
      { value: "keep", label: "Keep the set's tdd, and don't add pstack's" },
      { value: "replace", label: "Take pstack's tdd in place of the set's" },
      { value: "rename", label: "Take pstack's under another key, with a rename rule on pstack" },
    ],
    recommended: "keep",
  });
  expect(result.stdout).toContain("Nothing was added.");
  expect(readFileSync(join(clone, "skills/eng/tdd/SKILL.md"), "utf8")).toBe(skillMd("tdd"));
  expect(subjects(world, clone)).toHaveLength(1);
});

test("a key clashing with the set: renaming the newcomer adds a rename rule on its source", async () => {
  const world = createWorld({ set: { "skills/eng/tdd/SKILL.md": skillMd("tdd") } });
  world.source("poteto/pstack", {
    "skills/tdd/SKILL.md": skillMd("tdd"),
    "skills/architect/SKILL.md": `${skillMd("architect")}Then run tdd.\n`,
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "poteto/pstack", "tdd", "architect"], {
    cwd: clone,
    answers: ["names", "rename", "pstack-tdd", "misc", "misc", "no", [], ["pstack-tdd"], "yes"],
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[2]).toMatchObject({
    message: "Key for pstack's tdd in the set?",
    recommended: "pstack-tdd",
    allowTyped: "another key",
  });
  expect(readFileSync(join(clone, "skills/misc/pstack-tdd/SKILL.md"), "utf8")).toBe(skillMd("pstack-tdd"));
  expect(readFileSync(join(clone, "skills/misc/architect/SKILL.md"), "utf8")).toBe(
    `${skillMd("architect")}Then run pstack-tdd.\n`,
  );
  expect(readFileSync(join(clone, "skills/eng/tdd/SKILL.md"), "utf8")).toBe(skillMd("tdd"));
  const manifest = readManifest(clone);
  expect(manifest.sources.pstack.rename).toEqual([["tdd", "pstack-tdd"]]);
  expect(manifest.skills["pstack-tdd"]).toMatchObject({ source: "pstack", path: "skills/tdd" });
  expect(result.stdout).toContain("Rename rule on pstack: tdd → pstack-tdd.");
});

test("a key clashing with the set: taking the newcomer replaces the set's skill and its manifest entry", async () => {
  const world = createWorld({
    set: {
      "manifest.json": manifestWith(
        { skills: { repo: "mattpocock/skills", rename: [] } },
        { tdd: { source: "skills", path: "tdd", pin: "0".repeat(40), skipped: [] } },
      ),
      "skills/eng/tdd/SKILL.md": skillMd("tdd"),
      "skills/eng/tdd/old-notes.md": "Matt's notes.\n",
    },
  });
  const source = world.source("poteto/pstack", { "skills/tdd/SKILL.md": `${skillMd("tdd")}Theirs.\n` });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "poteto/pstack", "tdd"], {
    cwd: clone,
    answers: ["tdd", "replace", "misc", "no", "yes"],
  });

  expect(result.code, result.stderr).toBe(0);
  expect(readFileSync(join(clone, "skills/misc/tdd/SKILL.md"), "utf8")).toBe(`${skillMd("tdd")}Theirs.\n`);
  expect(existsSync(join(clone, "skills/eng/tdd"))).toBe(false);
  expect(readManifest(clone).skills).toEqual({
    tdd: { source: "pstack", path: "skills/tdd", pin: source.head(), skipped: [] },
  });
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
  expect(result.stdout).toContain("Replaced the set's tdd.");
});

test("replacing a skill takes the newcomer's group and moves it", async () => {
  const world = createWorld({ set: { "skills/eng/tdd/SKILL.md": skillMd("tdd") } });
  world.source("poteto/pstack", { "skills/tdd/SKILL.md": `${skillMd("tdd")}Theirs.\n` });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "poteto/pstack", "tdd"], {
    cwd: clone,
    answers: ["tdd", "replace", "misc", "no", "yes"],
  });

  expect(result.code, result.stderr).toBe(0);
  expect(existsSync(join(clone, "skills/eng/tdd"))).toBe(false);
  expect(readFileSync(join(clone, "skills/misc/tdd/SKILL.md"), "utf8")).toBe(`${skillMd("tdd")}Theirs.\n`);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("a set skill with uncommitted changes can't be replaced", async () => {
  const world = createWorld({ set: { "skills/eng/tdd/SKILL.md": skillMd("tdd") } });
  world.source("poteto/pstack", { "skills/tdd/SKILL.md": `${skillMd("tdd")}Theirs.\n` });
  const clone = world.cloneSet();
  world.recordClone(clone);
  writeFiles(clone, { "skills/eng/tdd/SKILL.md": `${skillMd("tdd")}Mine, unsaved.\n` });

  const result = await world.run(["add", "poteto/pstack", "tdd"], { cwd: clone, answers: ["tdd", "replace"] });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("skills/eng/tdd has uncommitted changes");
  expect(readFileSync(join(clone, "skills/eng/tdd/SKILL.md"), "utf8")).toBe(`${skillMd("tdd")}Mine, unsaved.\n`);
  expect(subjects(world, clone)).toHaveLength(1);
});

test("a key already taken earlier in the same run is asked again", async () => {
  const world = createWorld();
  world.source("acme/tools", {
    "a/SKILL.md": skillMd("review"),
    "b/SKILL.md": skillMd("code-review"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools", "review", "code-review"], {
    cwd: clone,
    answers: ["each", "review", { typed: "review" }, "code-review", "misc", "misc", "no", [], [], "yes"],
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("review is taken by a in this run. Pick another key.");
  expect(Object.keys(readManifest(clone).skills)).toEqual(["code-review", "review"]);
});

test("a clash under --yes stops with how to resolve it", async () => {
  const world = createWorld({ set: { "skills/eng/tdd/SKILL.md": skillMd("tdd") } });
  world.source("poteto/pstack", { "skills/tdd/SKILL.md": skillMd("tdd") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "poteto/pstack", "tdd", "--yes"], { cwd: clone });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("tdd is already in the set (skills/eng/tdd).");
  expect(result.stderr).toContain("Next: rerun without --yes to resolve the clash.");
});

test.each([
  ["a repo that doesn't exist", "acme/missing", "Can't reach acme/missing"],
  ["a ref the source doesn't have", "acme/tools#nope", "acme/tools has no branch, tag or commit named nope"],
])("%s fails with a clear message before any prompt, and nothing is committed", async (_case, ref, message) => {
  const world = createWorld();
  world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", ref], { cwd: clone });

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(message);
  expect(result.stderr).toContain("Nothing was added.");
  expect(result.prompts).toEqual([]);
  expect(subjects(world, clone)).toHaveLength(1);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("declining the push leaves the commit in the clone and says no machine sees it yet", async () => {
  const world = createWorld();
  world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);
  const before = remoteHead(world);

  const result = await world.run(["add", "acme/tools", "hello"], { cwd: clone, answers: ["hello", "misc", "no", "no"] });

  expect(result.code, result.stderr).toBe(0);
  expect(remoteHead(world)).toBe(before);
  expect(subjects(world, clone)[0]).toBe(`${SET_IDENTITY}|add: tools hello`);
  expect(result.stdout).toContain(
    "Added hello from tools in one commit.\nNot pushed: no machine sees this until you push.\n\nNext: run `git push` in the set's clone.\n",
  );
});

test("a failed push keeps the commit and says what to do", async () => {
  const world = createWorld();
  world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);
  world.set.commit({ "README.md": "Someone else pushed.\n" });

  const result = await world.run(["add", "acme/tools", "hello", "--yes"], { cwd: clone });

  expect(result.code).toBe(1);
  expect(subjects(world, clone)[0]).toBe(`${SET_IDENTITY}|add: tools hello`);
  expect(result.stdout).toContain("Added hello from tools in one commit.");
  expect(result.stderr).toContain("The push failed:");
  expect(result.stderr).toContain("Next: run `git pull --rebase` and `git push` in the set's clone.");
});

test("keeping each skill's own name still asks a key for one that would take an earlier one's", async () => {
  const world = createWorld();
  world.source("acme/tools", {
    "a/SKILL.md": skillMd("review"),
    "b/SKILL.md": skillMd("review"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "acme/tools"], {
    cwd: clone,
    answers: [["a", "b"], "names", { typed: "review-b" }, "misc", "misc", "no", [], [], "yes"],
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("review is taken by a in this run. Pick another key.");
  expect(readManifest(clone).skills).toMatchObject({ review: { path: "a" }, "review-b": { path: "b" } });
});

test("a new rename rule says which of the source's skills already in the set keep their old text", async () => {
  const world = createWorld({
    set: {
      "manifest.json": manifestWith(
        { pstack: { repo: "poteto/pstack", rename: [] } },
        { how: { source: "pstack", path: "skills/how", pin: "0".repeat(40), skipped: [] } },
      ),
      "skills/eng/how/SKILL.md": skillMd("how"),
      "skills/eng/tdd/SKILL.md": skillMd("tdd"),
    },
  });
  world.source("poteto/pstack", { "skills/tdd/SKILL.md": skillMd("tdd"), "skills/how/SKILL.md": skillMd("how") });
  const clone = world.cloneSet();
  world.recordClone(clone);

  const result = await world.run(["add", "poteto/pstack", "tdd"], {
    cwd: clone,
    answers: ["tdd", "rename", "pstack-tdd", "misc", "no", [], "yes"],
  });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    "Rename rule on pstack: tdd → pstack-tdd.\nNot re-rendered with the new rule until a sync: how.\n",
  );
});
