// Add and sync push the clone's current branch, setting its upstream when it has none,
// so they work on a trial's branch as well as on main.
import { expect, test } from "vitest";
import { createWorld, skillMd, type World } from "./world.js";

const remoteSubject = (world: World, branch: string) => world.git(["log", "-1", "--format=%s", branch], world.set.bare);
const upstreamOf = (world: World, clone: string) => world.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], clone);

test("add on a new branch pushes it and sets its upstream", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);
  world.git(["checkout", "-q", "-b", "try/hello"], clone);
  const main = world.git(["rev-parse", "main"], world.set.bare);

  const result = await world.run(["add", source.url, "hello", "--yes"], { cwd: clone });

  expect(result.code, result.stderr).toBe(0);
  expect(remoteSubject(world, "try/hello")).toBe("add: tools hello");
  expect(world.git(["rev-parse", "main"], world.set.bare)).toBe(main);
  expect(upstreamOf(world, clone)).toBe("origin/try/hello");
  expect(result.stdout).toMatch(
    /Pushed try\/hello and set its upstream to origin\/try\/hello\.\n\nNext: run \/setup-moro-skills in each project that should get them\.\n$/,
  );
});

test("sync on a new branch pushes it and sets its upstream; the next push needs no setting", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);
  expect((await world.run(["add", source.url, "hello", "--yes"], { cwd: clone })).code).toBe(0);
  world.git(["checkout", "-q", "-b", "try/hello"], clone);
  source.commit({ "skills/hello/extra.md": "extra\n" });

  const result = await world.run(["sync", "--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(remoteSubject(world, "try/hello")).toBe("sync: accept hello");
  expect(remoteSubject(world, "main")).toBe("add: tools hello");
  expect(upstreamOf(world, clone)).toBe("origin/try/hello");
  expect(result.stdout).toContain("Pushed try/hello and set its upstream to origin/try/hello.");

  source.commit({ "skills/hello/more.md": "more\n" });
  const again = await world.run(["sync", "--yes"]);
  expect(again.code, again.stderr).toBe(0);
  expect(world.git(["rev-parse", "try/hello"], world.set.bare)).toBe(world.git(["rev-parse", "HEAD"], clone));
  expect(again.stdout).toMatch(/\nPushed\.\n/);
});
