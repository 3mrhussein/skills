import { expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createWorld, writeFiles, type World } from "./world.js";

/** A device with a clone whose CLI build is current: the build file names the clone's HEAD. */
function setup() {
  const world = createWorld({ set: { "manifest.json": JSON.stringify({ moro: "0.1.0", sources: {}, skills: {} }) } });
  const clone = world.clone;
  world.recordClone(clone);
  world.env.MORO_BUILT_FROM = join(world.root, "built-from");
  rebuild(world);
  return { world, clone };
}

function rebuild(world: World) {
  writeFiles(world.root, { "built-from": `${world.git(["rev-parse", "HEAD"], world.clone)}\n` });
}

function commit(world: World, message: string, files: Record<string, string> = {}, date?: string) {
  const clone = world.clone;
  writeFiles(clone, { "note.txt": message, ...files });
  world.git(["add", "-A"], clone);
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: clone,
    env: { ...world.env, ...(date ? { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } : {}) },
  });
}

const today = () => new Date().toISOString();

test("outside a project, moro shows the clone's path and branch, its unpushed commits and its last sync", async () => {
  const { world, clone } = setup();
  commit(world, "sync: accept tdd", {}, "2026-01-02T10:00:00Z");
  commit(world, "local work");

  const { code, stdout } = await world.run([]);

  expect(code).toBe(0);
  expect(stdout).toContain(`Clone: ${clone} (main)`);
  expect(stdout).toMatch(/Unpushed: 2\n.*local work\n.*sync: accept tdd/);
  expect(stdout).toContain("Last sync: 2026-01-02");
});

test("with nothing unpushed and no sync yet, it says so", async () => {
  const { world } = setup();

  const { stdout } = await world.run([]);

  expect(stdout).toContain("Unpushed: none");
  expect(stdout).toContain("Last sync: never");
});

test("the next step is Up to date. when the build is current, nothing is unpushed and the sync is recent", async () => {
  const { world, clone } = setup();
  commit(world, "sync: accept tdd", {}, today());
  world.git(["push", "-q"], clone);
  rebuild(world);

  const { stdout } = await world.run([]);

  expect(stdout.trimEnd().split("\n").at(-1)).toBe("Up to date.");
});

test("a build older than the clone's cli/ comes before unpushed commits", async () => {
  const { world } = setup();
  commit(world, "cli change", { "cli/src/x.ts": "x" });

  const { stdout } = await world.run([]);

  expect(stdout.trimEnd().split("\n").at(-1)).toBe("Next: rerun ./install.sh, because the moro build is older than the clone's cli/.");
});

test("a build made after the last cli/ change is current even when later commits left cli/ alone", async () => {
  const { world } = setup();
  commit(world, "cli change", { "cli/src/x.ts": "x" });
  rebuild(world);
  commit(world, "skill change");

  const { stdout } = await world.run([]);

  expect(stdout).not.toContain("install.sh");
});

test("unpushed commits come before an old sync", async () => {
  const { world } = setup();
  commit(world, "sync: accept tdd", {}, "2020-01-01T00:00:00Z");
  rebuild(world);

  const { stdout } = await world.run([]);

  expect(stdout.trimEnd().split("\n").at(-1)).toBe("Next: push the clone's commits (git push).");
});

test("a sync over 30 days old is the next step once everything is pushed", async () => {
  const { world, clone } = setup();
  commit(world, "sync: accept tdd", {}, "2020-01-01T00:00:00Z");
  world.git(["push", "-q"], clone);
  rebuild(world);

  const { stdout } = await world.run([]);

  expect(stdout.trimEnd().split("\n").at(-1)).toBe("Next: run `moro sync` to check upstream skills.");
});

test("a missing build record is not a reason to rerun install.sh", async () => {
  const { world } = setup();
  world.env.MORO_BUILT_FROM = join(world.root, "nowhere");
  commit(world, "cli change", { "cli/src/x.ts": "x" });

  expect((await world.run([])).stdout).not.toContain("install.sh");
});

test("a project with a skills-lock.json is not the outside: bare moro leaves its report to the project branch", async () => {
  const { world } = setup();
  writeFiles(world.project, { "skills-lock.json": JSON.stringify({ version: 1, skills: {} }) });

  const { code, stdout } = await world.run([]);

  expect(code).toBe(0);
  expect(stdout).not.toContain("Clone:");
});

test("a manifest asking for a newer moro stops every command before it changes anything", async () => {
  const { world, clone } = setup();
  writeFiles(clone, { "manifest.json": JSON.stringify({ moro: "99.0.0", sources: {}, skills: {} }) });
  world.git(["add", "-A"], clone);
  const before = world.git(["status", "--porcelain"], clone);

  for (const argv of [[], ["sync"], ["add", "owner/repo", "--yes"], ["install"]]) {
    const result = await world.run(argv);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("needs moro 99.0.0");
    expect(result.stderr).toContain("Next: rerun ./install.sh in the set's clone.");
  }
  expect(world.git(["status", "--porcelain"], clone)).toBe(before);
});
