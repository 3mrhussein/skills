// `moro audit`: each skill at its source, in the set and in the current project (ADR 0007).
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, skillMd, writeFiles } from "./world.js";

const wording = (name: string, text: string) => skillMd(name).replace(`The ${name} skill.`, text);

/**
 * A set from `acme/tools`, one skill per source and set label, and an own skill:
 * - `edited`: hand edits and an upstream change;
 * - `plain`: the source's text, two upstream commits;
 * - `gone`: removed upstream;
 * - `mine`: hand edits only;
 * - `still`: the source's text, up to date;
 * - `own`: an own skill.
 * The source also holds `untaken`, which the set doesn't.
 */
async function auditedSet() {
  const world = createWorld();
  const names = ["edited", "plain", "gone", "mine", "still"];
  const source = world.source("acme/tools", {
    ...Object.fromEntries(names.map((name) => [`skills/${name}/SKILL.md`, skillMd(name)])),
    "skills/untaken/SKILL.md": skillMd("untaken"),
  });
  const clone = world.cloneSet();
  world.recordClone(clone);
  const added = await world.run(["add", source.url, ...names, "--yes"], { cwd: clone });
  expect(added.code, added.stderr).toBe(0);
  writeFiles(clone, {
    "skills/misc/edited/SKILL.md": wording("edited", "My edited wording."),
    "skills/misc/mine/SKILL.md": wording("mine", "My wording."),
    "skills/misc/own/SKILL.md": skillMd("own"),
  });
  world.git(["add", "-A"], clone);
  world.git(["commit", "-qm", "my edits"], clone);
  source.commit({ "skills/edited/notes.md": "notes\n", "skills/plain/a.md": "a\n" }, "first", ["skills/gone"]);
  source.commit({ "skills/plain/b.md": "b\n" }, "second");
  return { world, source, clone };
}

/** The cells of the table row for a skill. */
const row = (out: string, name: string) =>
  out
    .split("\n")
    .find((line) => line.startsWith(`${name} `))
    ?.trim()
    .split(/ {2,}/);

test("outside a project, each skill shows its source and set labels, then the skills to try, the untaken ones and one next step", async () => {
  const { world, clone } = await auditedSet();
  const head = world.git(["rev-parse", "HEAD"], clone);

  const result = await world.run(["audit"]);

  expect(result.code, result.stderr).toBe(0);
  const out = result.stdout;
  expect(out.split("\n")[0]!.trim().split(/ {2,}/)).toEqual(["skill", "source", "set"]);
  expect(row(out, "edited")).toEqual(["edited", "upstream +1 commit", "hand edits"]);
  expect(row(out, "plain")).toEqual(["plain", "upstream +2 commits", "source's text"]);
  expect(row(out, "gone")).toEqual(["gone", "removed upstream", "source's text"]);
  expect(row(out, "mine")).toEqual(["mine", "up to date", "hand edits"]);
  expect(row(out, "still")).toEqual(["still", "up to date", "source's text"]);
  expect(row(out, "own")).toEqual(["own", "own skill", "-"]);
  expect(out).toContain("\nUpstream change and hand edits:\n  edited: fall back or adapt? Next: run `moro try edited`.\n");
  expect(out).not.toContain("mine: fall back");
  expect(out).toContain("\nIn the sources, not in the set:\n  tools: untaken (skills/untaken)\n");
  expect(out).toMatch(/\nNext: run `moro try edited` to fall back or adapt\.\n$/);
  // It changes nothing.
  expect(world.git(["rev-parse", "HEAD"], clone)).toBe(head);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("with only plain upstream changes, the next step is moro sync; with none, up to date", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);
  expect((await world.run(["add", source.url, "hello", "--yes"], { cwd: clone })).code).toBe(0);

  const current = await world.run(["audit"]);
  expect(current.code, current.stderr).toBe(0);
  expect(row(current.stdout, "hello")).toEqual(["hello", "up to date", "source's text"]);
  expect(current.stdout).not.toContain("Upstream change and hand edits");
  expect(current.stdout).not.toContain("In the sources");
  expect(current.stdout).toMatch(/\nUp to date\.\n$/);

  source.commit({ "skills/hello/a.md": "a\n" });
  const changed = await world.run(["audit"]);
  expect(changed.stdout).toMatch(/\nNext: run `moro sync` to decide the upstream changes\.\n$/);
});

test("inside a project, a column shows each skill's divergence labels or same as set", async () => {
  const { world } = await auditedSet();
  const installed = await world.run(["install", "--yes", "--pick", "still", "plain", "own"]);
  expect(installed.code, installed.stderr).toBe(0);
  const copy = join(world.project, ".agents/skills/own/SKILL.md");
  writeFileSync(copy, wording("own", "Edited in the project."));

  const result = await world.run(["audit"]);

  expect(result.code, result.stderr).toBe(0);
  const out = result.stdout;
  expect(out.split("\n")[0]!.trim().split(/ {2,}/)).toEqual(["skill", "source", "set", "this project"]);
  expect(row(out, "still")).toEqual(["still", "up to date", "source's text", "same as set"]);
  expect(row(out, "plain")).toEqual(["plain", "upstream +2 commits", "source's text", "same as set"]);
  expect(row(out, "own")).toEqual(["own", "own skill", "-", "edited here"]);
  expect(row(out, "mine")).toEqual(["mine", "up to date", "hand edits", "not installed"]);
  expect(out).toMatch(/\nNext: run `moro try edited` to fall back or adapt\.\n$/);
});

test("a project that differs from the set, with no upstream change, is told to rerun setup; a skill gone from the set gets a row", async () => {
  const world = createWorld();
  const source = world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  const clone = world.cloneSet();
  world.recordClone(clone);
  expect((await world.run(["add", source.url, "hello", "--yes"], { cwd: clone })).code).toBe(0);
  writeFiles(clone, { "skills/misc/bye/SKILL.md": skillMd("bye") });
  world.git(["add", "-A"], clone);
  world.git(["commit", "-qm", "bye"], clone);
  expect((await world.run(["install", "--yes", "--pick", "hello", "bye"])).code).toBe(0);
  writeFileSync(join(clone, "skills/misc/hello/SKILL.md"), wording("hello", "Changed in the set."));
  rmSync(join(clone, "skills/misc/bye"), { recursive: true });
  world.git(["commit", "-qam", "my edit, bye gone"], clone);

  const result = await world.run(["audit"]);

  expect(result.code, result.stderr).toBe(0);
  expect(row(result.stdout, "hello")).toEqual(["hello", "up to date", "hand edits", "set changed"]);
  expect(row(result.stdout, "bye")).toEqual(["bye", "-", "-", "gone from the set"]);
  expect(result.stdout).toMatch(/\nNext: rerun `\/setup-moro-skills`\.\n$/);
});

test("an unreachable source is reported on stderr and its skills show as unreachable, while other sources are still audited", async () => {
  const { world, clone } = await auditedSet();
  const other = world.source("acme/more", { "skills/far/SKILL.md": skillMd("far") });
  expect((await world.run(["add", other.url, "far", "--yes"], { cwd: clone })).code).toBe(0);
  rmSync(other.bare, { recursive: true, force: true });

  const result = await world.run(["audit"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Can't reach more");
  expect(result.stderr).toContain("Its skills show as unreachable.");
  expect(row(result.stdout, "far")).toEqual(["far", "unreachable", "-"]);
  expect(row(result.stdout, "plain")).toEqual(["plain", "upstream +2 commits", "source's text"]);
});

test("--json prints the audit for manage-moro-skills and changes nothing", async () => {
  const { world, clone } = await auditedSet();
  const head = world.git(["rev-parse", "HEAD"], clone);

  const result = await world.run(["audit", "--json"]);

  expect(result.code, result.stderr).toBe(0);
  const json = JSON.parse(result.stdout);
  expect(json.set).toBe(clone);
  expect(json.project).toBeNull();
  const byName = Object.fromEntries(json.skills.map((skill: any) => [skill.name, skill]));
  expect(byName.edited).toEqual({ name: "edited", source: "upstream +1 commit", commits: 1, set: "hand edits", handEdits: ["SKILL.md"], project: null });
  expect(byName.plain).toMatchObject({ source: "upstream +2 commits", commits: 2, set: "source's text", handEdits: [] });
  expect(byName.own).toMatchObject({ source: "own skill", commits: null, set: null, handEdits: null });
  expect(json.try).toEqual(["edited"]);
  expect(json.untaken).toEqual([{ source: "tools", name: "untaken", path: "skills/untaken" }]);
  expect(json.unreachable).toEqual([]);
  expect(json.next).toBe("Next: run `moro try edited` to fall back or adapt.");
  expect(world.git(["rev-parse", "HEAD"], clone)).toBe(head);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
});

test("audit takes only --json", async () => {
  const { world } = await auditedSet();

  const result = await world.run(["audit", "edited"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Next: run moro audit [--json]");
});

test("in a trial's worktree, audit reads that candidate's set", async () => {
  const { world, clone } = await auditedSet();
  expect((await world.run(["try", "edited"])).code).toBe(0);

  const result = await world.run(["audit"], { cwd: `${clone}-try/edited-fallback` });

  expect(result.code, result.stderr).toBe(0);
  expect(row(result.stdout, "edited")).toEqual(["edited", "up to date", "source's text"]);
  expect(result.stdout).toMatch(/\nNext: run `moro sync` to decide the upstream changes\.\n$/);
});
