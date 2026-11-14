import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, type Files, skillMd, type World, writeFiles } from "./world.js";

const SKILL = "setup-moro-skills";

/** A set holding `setup-moro-skills` and `files`. */
function worldWith(files: Files = {}): World {
  return createWorld({ set: { [`skills/meta/${SKILL}/SKILL.md`]: skillMd(SKILL), ...files } });
}

const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
const userLevel = (world: World) => ({
  lock: Object.keys(world.readLock()?.skills ?? {}).sort(),
  agents: list(join(world.home, ".agents/skills")),
  claude: list(join(world.home, ".claude/skills")),
});

test("a user-level skill with a set skill's name and the same files is ticked to remove; others are left and named", async () => {
  const world = worldWith({ "skills/engineering/tdd/SKILL.md": skillMd("tdd") });
  writeFiles(world.home, {
    ".agents/skills/tdd/SKILL.md": skillMd("tdd"),
    ".agents/skills/find-skills/SKILL.md": skillMd("find-skills"),
  });

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: [["tdd"]] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toHaveLength(1);
  expect(result.prompts[0]).toMatchObject({
    message: "Which shadowing skills should go?",
    choices: [{ value: "tdd", picked: true }],
  });
  expect(result.stdout).toMatch(/1\. \[x\] tdd +same as the set's +remove\n/);
  expect(result.stdout).toContain("Left at user level: find-skills.");
  expect(result.stdout).toContain("Removed: tdd.");
  expect(userLevel(world).agents).toEqual(["find-skills", SKILL]);
});

/** A set whose `ask-moro` is the source's `ask-matt` renamed, plus a hand edit; the source's skill is installed at user level. */
async function renamedUpstreamWorld(): Promise<World> {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/ask-matt/SKILL.md": skillMd("ask-matt") });
  world.set.commit({
    [`skills/meta/${SKILL}/SKILL.md`]: skillMd(SKILL),
    "skills/meta/ask-moro/SKILL.md": `${skillMd("ask-moro")}\nA hand edit.\n`,
    "manifest.json": JSON.stringify({
      moro: "0.2.0",
      sources: { acme: { repo: source.url, rename: [["ask-matt", "ask-moro"]] } },
      skills: { "ask-moro": { source: "acme", path: "skills/ask-matt", pin: source.head(), skipped: [] } },
      recommended: [],
      dependsOn: {},
    }),
  });
  expect((await world.skills(["add", source.url, "-g", "-y", "--skill", "ask-matt"])).code).toBe(0);
  return world;
}

test("a lock entry from an upstream skill's source and path shadows whatever its name, and is ticked when unedited", async () => {
  const world = await renamedUpstreamWorld();
  const source = world.readLock()!.skills["ask-matt"]!.source;

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: [["ask-matt"]] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[0]).toMatchObject({ choices: [{ value: "ask-matt", picked: true }] });
  expect(result.stdout).toContain(`from ${source},`);
  expect(result.stdout).toMatch(/1\. \[x\] ask-matt +from .*remove: the set's copy\n/);
  expect(result.stdout).toContain("Removed: ask-matt.");
  expect(userLevel(world)).toEqual({ lock: [SKILL], agents: [SKILL], claude: [SKILL] });
});

test("an edited copy, or one that only shares a name, differs: unticked, its files listed, kept with a warning", async () => {
  const world = await renamedUpstreamWorld();
  world.set.commit({ "skills/meta/handmade/SKILL.md": skillMd("handmade"), "skills/meta/handmade/a.md": "a", "skills/meta/handmade/b.md": "b" });
  writeFiles(world.home, {
    ".agents/skills/ask-matt/SKILL.md": `${skillMd("ask-matt")}\nMy edit.\n`,
    ".claude/skills/handmade/SKILL.md": "mine",
    ".claude/skills/handmade/c.md": "c",
    ".claude/skills/handmade/d.md": "d",
  });

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: [[]] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts[0]).toMatchObject({
    choices: [
      { value: "ask-matt", picked: false },
      { value: "handmade", picked: false },
    ],
  });
  expect(result.stdout).toMatch(/1\. \[ \] ask-matt +differs from the set's +keep: may hold your edits\n +SKILL\.md\n/);
  expect(result.stdout).toMatch(/2\. \[ \] handmade +differs from the set's +keep: may hold your edits\n +SKILL\.md, a\.md, b\.md, \+2 more\n/);
  expect(result.stdout).toContain("Kept: ask-matt. It shadows a project's install; compare it with the set's copy, then rerun ./install.sh.");
  expect(result.stdout).toContain("Kept: handmade.");
  expect(existsSync(join(world.home, ".config/moro/backups"))).toBe(false);
  expect(userLevel(world).claude).toEqual(["ask-matt", "handmade", SKILL]);
});

test("a local-only skill's name shadows too", async () => {
  const world = worldWith();
  writeFiles(world.clone, { "local-only/work/device-notes/SKILL.md": skillMd("device-notes") });
  writeFiles(world.home, { ".agents/skills/device-notes/SKILL.md": skillMd("device-notes") });

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: [["device-notes"]] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/1\. \[x\] device-notes +same as the set's/);
  expect(userLevel(world).agents).toEqual([SKILL]);
});

/** Every label at once: `tdd` the same, `ask-matt` from its source, `handmade` differing, and `find-skills` shadowing nothing. */
async function everyLabelWorld(): Promise<World> {
  const world = await renamedUpstreamWorld();
  world.set.commit({ "skills/engineering/tdd/SKILL.md": skillMd("tdd"), "skills/meta/handmade/SKILL.md": skillMd("handmade") });
  writeFiles(world.home, {
    ".agents/skills/tdd/SKILL.md": skillMd("tdd"),
    ".agents/skills/handmade/SKILL.md": "mine",
    ".claude/skills/find-skills/SKILL.md": skillMd("find-skills"),
  });
  return world;
}

const today = () => new Date().toISOString().slice(0, 10);

test("--yes takes the ticks: removes the same and from-source rows, keeps the differing one, after the snapshot", async () => {
  const world = await everyLabelWorld();

  const result = await world.run(["bootstrap", "--yes"], { cwd: world.clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(result.stdout).toContain("3 user-level skills shadow the set's. Every removal is snapshotted first.");
  expect(result.stdout).toContain("Kept: handmade.");
  expect(result.stdout).toContain("Removed: ask-matt, tdd.");
  expect(existsSync(join(world.home, ".config/moro/backups", `${today()}.tar.gz`))).toBe(true);
  expect(userLevel(world)).toEqual({ lock: [SKILL], agents: ["handmade", SKILL], claude: ["find-skills", SKILL] });
});

test("before the first removal it tars the skills folder, the Claude links and the lock, and prints how to restore", async () => {
  const world = await everyLabelWorld();

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: [["tdd", "ask-matt", "handmade"]] });

  const archive = join(world.home, ".config/moro/backups", `${today()}.tar.gz`);
  expect(result.stdout).toContain(`Snapshot: ${archive}`);
  expect(result.stdout).toContain(`tar -xzf ${archive} -C /`);
  const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  for (const part of [".agents/skills/tdd/SKILL.md", ".agents/skills/ask-matt/SKILL.md", ".agents/skills/handmade/SKILL.md", ".claude/skills/find-skills/SKILL.md", ".agents/.skill-lock.json"]) {
    expect(listing).toContain(part);
  }
  expect(userLevel(world)).toEqual({ lock: [SKILL], agents: [SKILL], claude: ["find-skills", SKILL] });
  // Restoring by hand brings the retired skills back.
  execFileSync("tar", ["-xzf", archive, "-C", "/"]);
  expect(userLevel(world).agents).toEqual(["ask-matt", "handmade", SKILL, "tdd"]);
  expect(userLevel(world).lock).toContain("ask-matt");
  expect(lstatSync(join(world.home, ".claude/skills/ask-matt")).isSymbolicLink()).toBe(true);
});

test("nothing remembers a refusal: a rerun asks again, and about a skill a pull made shadowing", async () => {
  const world = await everyLabelWorld();
  await world.run(["bootstrap"], { cwd: world.clone, answers: [[]] });
  world.set.commit({ "skills/meta/find-skills/SKILL.md": skillMd("find-skills") });
  world.git(["pull", "-q"], world.clone);

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: [[]] });

  expect(result.code, result.stderr).toBe(0);
  expect((result.prompts[0] as any).choices.map((choice: any) => choice.value)).toEqual(["find-skills", "tdd", "ask-matt", "handmade"]);
  expect(result.stdout).not.toContain("Left at user level");
});

test("with no shadowing skill it asks nothing, takes no snapshot and names the skills it leaves, not stray files", async () => {
  const world = worldWith();
  writeFiles(world.home, { ".claude/skills/find-skills/SKILL.md": skillMd("find-skills"), ".claude/skills/.DS_Store": "", ".agents/skills/notes.txt": "" });
  mkdirSync(join(world.home, ".claude/skills/synced"), { recursive: true });

  const result = await world.run(["bootstrap"], { cwd: world.clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(result.stdout).toContain("\nLeft at user level: find-skills.\n");
  expect(result.stdout).not.toContain("shadow");
  expect(existsSync(join(world.home, ".config/moro/backups"))).toBe(false);
});

test("setup-moro-skills is never a shadowing skill, even from its upstream source under another name", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/setup-matt-skills/SKILL.md": skillMd("setup-matt-skills") });
  world.set.commit({
    [`skills/meta/${SKILL}/SKILL.md`]: skillMd(SKILL),
    "manifest.json": JSON.stringify({
      moro: "0.2.0",
      sources: { acme: { repo: source.url, rename: [] } },
      skills: { [SKILL]: { source: "acme", path: "skills/setup-matt-skills", pin: source.head(), skipped: [] } },
      recommended: [],
      dependsOn: {},
    }),
  });
  expect((await world.skills(["add", source.url, "-g", "-y"])).code).toBe(0);

  const result = await world.run(["bootstrap"], { cwd: world.clone });

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(result.stdout).toContain("Left at user level: setup-matt-skills.");
});

test("the report and the picker are one aligned table; Enter keeps the ticked rows", async () => {
  const world = await everyLabelWorld();

  const result = await world.run(["bootstrap"], { cwd: world.clone, typed: "\n" });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    [
      "3 user-level skills shadow the set's. Every removal is snapshotted first.",
      "",
      "         Skill       Against the set's copy                        Recommended",
      "  1. [x] tdd         same as the set's                             remove",
      "  2. [x] ask-matt    from https://git.moro.test/acme/tools.git,    remove: the set's copy",
      "                     like the set's                                replaces it",
      "  3. [ ] handmade    differs from the set's                        keep: may hold your edits",
      "                       SKILL.md",
      "",
      "Left at user level: find-skills.",
      "",
      "Which shadowing skills should go?",
      "  Type the numbers to take (like 1 3 5-7), all or none; Enter keeps the ticked ones.",
      "> ",
    ].join("\n"),
  );
  expect(result.stdout).not.toContain("\x1b");
  expect(result.stdout).toContain("Removed: ask-matt, tdd.");
  expect(userLevel(world).agents).toEqual(["handmade", SKILL]);
});

test("typing numbers takes exactly those rows", async () => {
  const world = await everyLabelWorld();

  const result = await world.run(["bootstrap"], { cwd: world.clone, typed: "3\n" });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("Removed: handmade.");
  expect(result.stdout).toContain("Kept: ask-matt.");
  expect(result.stdout).toContain("Kept: tdd.");
  expect(userLevel(world).agents).toEqual(["ask-matt", SKILL, "tdd"]);
});

test("in a terminal the Recommended column is dim", async () => {
  const world = await everyLabelWorld();

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: [[]], tty: true });

  expect(result.stdout).toMatch(/same as the set's +\x1b\[2mremove\x1b\[22m\n/);
  expect(result.stdout).toContain("\x1b[2mkeep: may hold your edits\x1b[22m");
});

test("a lock entry with a GitHub tree hash counts as unedited while its files still hash to it", async () => {
  const world = await renamedUpstreamWorld();
  const folder = join(world.home, ".agents/skills/ask-matt");
  writeFiles(folder, { "references/run.sh": { content: "echo hi\n", mode: 0o755 }, "z.md": "z" });
  // git's own tree hash of the folder, as GitHub reports it.
  const scratch = join(world.root, "tree-hash");
  world.git(["init", "-q", scratch], world.root);
  execFileSync("cp", ["-R", folder, join(scratch, "ask-matt")]);
  world.git(["add", "ask-matt"], scratch);
  const treeHash = world.git(["write-tree", "--prefix=ask-matt/"], scratch);
  const lockFile = join(world.home, ".agents/.skill-lock.json");
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  lock.skills["ask-matt"].skillFolderHash = treeHash;
  writeFileSync(lockFile, JSON.stringify(lock));

  const unedited = await world.run(["bootstrap"], { cwd: world.clone, answers: [[]] });
  writeFiles(folder, { "z.md": "edited" });
  const edited = await world.run(["bootstrap"], { cwd: world.clone, answers: [[]] });

  expect(unedited.prompts[0]).toMatchObject({ choices: [{ value: "ask-matt", picked: true }] });
  expect(edited.prompts[0]).toMatchObject({ choices: [{ value: "ask-matt", picked: false }] });
});

test("a same-named copy installed from another set skill's upstream differs", async () => {
  const world = await renamedUpstreamWorld();
  world.set.commit({ "skills/engineering/tdd/SKILL.md": skillMd("tdd") });
  const lockFile = join(world.home, ".agents/.skill-lock.json");
  const lock = JSON.parse(readFileSync(lockFile, "utf8"));
  // An unedited install of ask-matt's upstream, under the name tdd.
  lock.skills.tdd = lock.skills["ask-matt"];
  delete lock.skills["ask-matt"];
  writeFileSync(lockFile, JSON.stringify(lock));
  execFileSync("mv", [join(world.home, ".agents/skills/ask-matt"), join(world.home, ".agents/skills/tdd")]);

  const result = await world.run(["bootstrap"], { cwd: world.clone, answers: [[]] });

  expect(result.prompts[0]).toMatchObject({ choices: [{ value: "tdd", picked: false }] });
  expect(result.stdout).toMatch(/tdd +differs from the set's/);
});
