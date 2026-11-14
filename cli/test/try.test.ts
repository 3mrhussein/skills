// `moro try <skill>`: a trial of a skill's candidates, each on a branch of the clone in its own
// worktree beside it, and `moro install --from <worktree>` for a trial project (ADR 0007).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, readManifest, skillMd, type World } from "./world.js";

const callerMd = `---\nname: caller\ndescription: Use for caller.\n---\n\nCall the Skill tool with "hello".\n`;
const wording = (text: string) => skillMd("hello").replace("The hello skill.", text);
const helloIn = (dir: string, path = "SKILL.md") => join(dir, "skills/misc/hello", path);
const read = (file: string) => readFileSync(file, "utf8");

/** A set with `hello` (two files) and `caller`, which calls it, added from one source. */
async function trialSet() {
  const world = createWorld();
  const source = world.source("acme/tools", {
    "skills/hello/SKILL.md": skillMd("hello"),
    "skills/hello/notes.md": "one\ntwo\n",
    "skills/caller/SKILL.md": callerMd,
  });
  const clone = world.cloneSet();
  world.recordClone(clone);
  for (const args of [["hello"], ["caller", "--depends-on", "hello"]]) {
    const added = await world.run(["add", source.url, ...args, "--yes"], { cwd: clone });
    expect(added.code, added.stderr).toBe(0);
  }
  const trial = (name: string) => `${clone}-try/${name}`;
  return { world, source, clone, trial };
}

function edit(world: World, clone: string, path: string, text: string): void {
  writeFileSync(helloIn(clone, path), text);
  world.git(["commit", "-qam", "my edit"], clone);
}

const trialBranches = (world: World, clone: string) => world.git(["branch", "--list", "try/*", "--format=%(refname:short)"], clone);

test("with hand edits, try makes the fallback and adapted candidates off main in worktrees, each with its diff, check and impact", async () => {
  const { world, source, clone, trial } = await trialSet();
  edit(world, clone, "notes.md", "ONE\ntwo\n");
  const head = source.commit({ "skills/hello/SKILL.md": wording('Call the Skill tool with "helper".') }, "Call helper");
  const main = world.git(["rev-parse", "main"], clone);

  const result = await world.run(["try", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  const [fallback, adapted] = [trial("hello-fallback"), trial("hello-adapted")];
  expect(world.git(["branch", "--show-current"], fallback)).toBe("try/hello-fallback");
  expect(world.git(["branch", "--show-current"], adapted)).toBe("try/hello-adapted");
  expect(read(helloIn(fallback))).toBe(wording('Call the Skill tool with "helper".'));
  expect(read(helloIn(fallback, "notes.md"))).toBe("one\ntwo\n");
  expect(read(helloIn(adapted))).toBe(wording('Call the Skill tool with "helper".'));
  expect(read(helloIn(adapted, "notes.md"))).toBe("ONE\ntwo\n");
  expect(world.git(["log", "-1", "--format=%s", "try/hello-fallback"], clone)).toBe("sync: fall back hello");
  expect(world.git(["log", "-1", "--format=%s", "try/hello-adapted"], clone)).toBe("sync: accept hello");
  expect(readManifest(fallback).skills.hello.pin).toBe(head);
  expect(readManifest(adapted).skills.hello.pin).toBe(head);

  // main and the clone's working tree are untouched.
  expect(world.git(["rev-parse", "main"], clone)).toBe(main);
  expect(world.git(["status", "--porcelain"], clone)).toBe("");
  expect(read(helloIn(clone, "notes.md"))).toBe("ONE\ntwo\n");
  expect(readManifest(clone).skills.hello.pin).not.toBe(head);

  const out = result.stdout;
  expect(out).toContain(`Trial of hello off main (${main.slice(0, 7)}): main stays as it is until you keep a candidate.`);
  expect(out).toContain(`Fallback: drops your hand edits and takes the upstream text as it is. Committed on try/hello-fallback.\nWorktree: ${fallback}\nDiff against main:\n`);
  expect(out).toContain(`Adapted: your hand edits merged with the upstream change. Committed on try/hello-adapted.\nWorktree: ${adapted}\nDiff against main:\n`);
  expect(out).toContain("-ONE\n+one\n");
  expect(out).toContain('+Call the Skill tool with "helper".');
  expect(out.match(/Workflow check: 2 findings:\n  hello calls "helper", which isn't in the set\.\n/g)).toHaveLength(2);
  expect(out.match(/Impact: caller calls hello directly\./g)).toHaveLength(2);
  expect(out).toContain(`Try it in a project: moro install --from ${fallback}`);
  expect(out).toContain(`Try it in a project: moro install --from ${adapted}`);
  expect(out).toMatch(
    /\nNext: run each candidate's `moro install --from` line in a trial project, then `moro try hello --keep fallback` or `moro try hello --keep adapted`, or `moro try hello --drop` to keep main as it is\.\n$/,
  );
});

test("--json prints the candidates for manage-moro-skills", async () => {
  const { world, source, clone, trial } = await trialSet();
  edit(world, clone, "notes.md", "ONE\ntwo\n");
  source.commit({ "skills/hello/SKILL.md": wording("Upstream wording.") });

  const result = await world.run(["try", "hello", "--json"]);

  expect(result.code, result.stderr).toBe(0);
  const json = JSON.parse(result.stdout);
  expect(json.skill).toBe("hello");
  expect(json.main).toBe(world.git(["rev-parse", "main"], clone));
  expect(json.candidates.map((c: any) => [c.name, c.branch, c.worktree, c.committed, c.conflicts])).toEqual([
    ["fallback", "try/hello-fallback", trial("hello-fallback"), true, []],
    ["adapted", "try/hello-adapted", trial("hello-adapted"), true, []],
  ]);
  for (const candidate of json.candidates) {
    expect(candidate.diff).toContain("+Upstream wording.");
    expect(candidate.findings).toEqual([]);
    expect(candidate.impact).toEqual([{ skill: "caller", depth: 1, via: ["caller", "hello"] }]);
    expect(candidate.install).toBe(`moro install --from ${candidate.worktree}`);
  }
  expect(json.next).toBe(
    "Next: run each candidate's `moro install --from` line in a trial project, then `moro try hello --keep fallback` or `moro try hello --keep adapted`, or `moro try hello --drop` to keep main as it is.",
  );
});

test("without hand edits, try makes one worktree, try/<skill>, with accept, and --keep takes it", async () => {
  const { world, source, clone, trial } = await trialSet();
  source.commit({ "skills/hello/extra.md": "extra\n" });

  const result = await world.run(["try", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(trialBranches(world, clone)).toBe("try/hello");
  expect(existsSync(trial("hello-fallback"))).toBe(false);
  expect(read(helloIn(trial("hello"), "extra.md"))).toBe("extra\n");
  expect(world.git(["log", "-1", "--format=%s", "try/hello"], clone)).toBe("sync: accept hello");
  expect(result.stdout).toContain(
    `Accept: hello has no hand edits, so accept and fallback are the same. Committed on try/hello.\nWorktree: ${trial("hello")}`,
  );
  expect(result.stdout).toMatch(/\nNext: run `moro install --from \S+` in a trial project, then `moro try hello --keep`, or `moro try hello --drop` to keep main as it is\.\n$/);

  const kept = await world.run(["try", "hello", "--keep"], { answers: ["no"] });

  expect(kept.code, kept.stderr).toBe(0);
  expect(read(helloIn(clone, "extra.md"))).toBe("extra\n");
  expect(trialBranches(world, clone)).toBe("");
  expect(existsSync(`${clone}-try`)).toBe(false);
});

test("a conflicted adapted candidate keeps its markers; sync accept in its worktree commits there; --keep waits for it", async () => {
  const { world, source, clone, trial } = await trialSet();
  edit(world, clone, "SKILL.md", wording("My wording."));
  source.commit({ "skills/hello/SKILL.md": wording("Upstream wording.") });
  const main = world.git(["rev-parse", "main"], clone);
  const adapted = trial("hello-adapted");

  const result = await world.run(["try", "hello"]);

  expect(result.code, result.stderr).toBe(0);
  expect(read(helloIn(adapted))).toContain("<<<<<<< yours");
  expect(read(helloIn(trial("hello-fallback")))).toBe(wording("Upstream wording."));
  expect(result.stdout).toContain(
    `Adapted: your hand edits merged with the upstream change, with conflict markers in SKILL.md: resolve them, then run \`moro sync accept hello\` in its worktree.\nWorktree: ${adapted}`,
  );
  expect(result.stdout).toMatch(
    new RegExp(`\\nNext: resolve the markers in ${adapted}, then run \`moro sync accept hello\` there; or run \`moro try hello --keep fallback\`\\.\\n$`),
  );

  const early = await world.run(["try", "hello", "--keep", "adapted"]);
  expect(early.code).toBe(1);
  expect(early.stderr).toContain(`The adapted candidate has uncommitted changes in ${adapted}, so it can't be kept yet. Nothing was changed.`);
  expect(early.stderr).toContain("Next: resolve the markers, then run `moro sync accept hello` in that worktree.");

  writeFileSync(helloIn(adapted), wording("My upstream wording."));
  const accepted = await world.run(["sync", "accept", "hello"], { cwd: adapted });

  expect(accepted.code, accepted.stderr).toBe(0);
  expect(world.git(["log", "-1", "--format=%s", "try/hello-adapted"], clone)).toBe("sync: accept hello");
  expect(world.git(["status", "--porcelain"], adapted)).toBe("");
  expect(world.git(["rev-parse", "main"], clone)).toBe(main);
  expect(accepted.stdout).not.toContain("Not pushed");
  expect(accepted.stdout).toMatch(/\nNext: run `moro try hello` to compare the candidates again\.\n$/);

  const again = await world.run(["try", "hello"]);
  expect(again.stdout).toContain("Adapted: your hand edits merged with the upstream change. Committed on try/hello-adapted.");
});

test("rerunning try on a skill with a trial open shows that trial and makes nothing new", async () => {
  const { world, source, clone } = await trialSet();
  edit(world, clone, "notes.md", "ONE\ntwo\n");
  source.commit({ "skills/hello/SKILL.md": wording("Upstream wording.") });
  const first = await world.run(["try", "hello"]);
  const commits = world.git(["rev-parse", "try/hello-fallback", "try/hello-adapted"], clone);

  const again = await world.run(["try", "hello"]);

  expect(again.code, again.stderr).toBe(0);
  expect(world.git(["rev-parse", "try/hello-fallback", "try/hello-adapted"], clone)).toBe(commits);
  expect(again.stdout).toBe(first.stdout.replace("Trial of hello off main", "Trial of hello, already open, off main"));
});

test("--keep adapted merges it into main, removes both worktrees and branches, and pushes on yes", async () => {
  const { world, source, clone, trial } = await trialSet();
  edit(world, clone, "notes.md", "ONE\ntwo\n");
  source.commit({ "skills/hello/SKILL.md": wording("Upstream wording.") });
  expect((await world.run(["try", "hello"])).code).toBe(0);

  const kept = await world.run(["try", "hello", "--keep", "adapted"], { answers: ["yes"] });

  expect(kept.code, kept.stderr).toBe(0);
  expect((kept.prompts[0] as any).message).toBe("Push now?");
  expect(read(helloIn(clone))).toBe(wording("Upstream wording."));
  expect(read(helloIn(clone, "notes.md"))).toBe("ONE\ntwo\n");
  expect(world.git(["log", "-1", "--format=%s", "main"], clone)).toBe("sync: accept hello");
  expect(existsSync(trial("hello-fallback")) || existsSync(trial("hello-adapted"))).toBe(false);
  expect(existsSync(`${clone}-try`)).toBe(false);
  expect(trialBranches(world, clone)).toBe("");
  expect(world.git(["rev-parse", "main"], world.set.bare)).toBe(world.git(["rev-parse", "main"], clone));
  expect(kept.stdout).toContain("Kept the adapted hello: merged try/hello-adapted into main, and removed the trial's worktrees and branches.");
  expect(kept.stdout).toMatch(/\nPushed main\.\n\nNext: run \/setup-moro-skills in each project that should get the change; in a trial project that brings it back to main\.\n$/);
});

test("--drop removes the trial and keeps main as it is", async () => {
  const { world, source, clone, trial } = await trialSet();
  edit(world, clone, "notes.md", "ONE\ntwo\n");
  source.commit({ "skills/hello/SKILL.md": wording("Upstream wording.") });
  const main = world.git(["rev-parse", "main"], clone);
  expect((await world.run(["try", "hello"])).code).toBe(0);
  // An uncommitted change in a candidate goes with it.
  writeFileSync(helloIn(trial("hello-adapted")), "scratch\n");

  const dropped = await world.run(["try", "hello", "--drop"]);

  expect(dropped.code, dropped.stderr).toBe(0);
  expect(dropped.prompts).toEqual([]);
  expect(world.git(["rev-parse", "main"], clone)).toBe(main);
  expect(trialBranches(world, clone)).toBe("");
  expect(existsSync(`${clone}-try`)).toBe(false);
  expect(dropped.stdout).toBe(
    "Dropped the trial of hello: removed its worktrees and branches; main is as it was.\n\nNext: run /setup-moro-skills in each trial project to bring it back to main.\n",
  );
  expect((await world.run(["try", "hello", "--drop"])).stderr).toContain("hello has no trial open.");
});

test("add in a candidate's worktree commits on its branch and pushes it; --keep then deletes it from origin", async () => {
  const { world, source, clone, trial } = await trialSet();
  edit(world, clone, "notes.md", "ONE\ntwo\n");
  source.commit({ "skills/hello/SKILL.md": wording('Call the Skill tool with "helper".'), "skills/helper/SKILL.md": skillMd("helper") });
  expect((await world.run(["try", "hello"])).code).toBe(0);
  const adapted = trial("hello-adapted");

  const added = await world.run(["add", source.url, "helper", "--yes"], { cwd: adapted });

  expect(added.code, added.stderr).toBe(0);
  expect(existsSync(join(adapted, "skills/misc/helper/SKILL.md"))).toBe(true);
  expect(existsSync(join(clone, "skills/misc/helper"))).toBe(false);
  expect(world.git(["log", "-1", "--format=%s", "try/hello-adapted"], world.set.bare)).toBe("add: tools helper");
  expect(added.stdout).toContain("Pushed try/hello-adapted and set its upstream to origin/try/hello-adapted.");
  const shown = await world.run(["try", "hello"]);
  expect(shown.stdout).toContain("Workflow check: 1 finding:\n  hello calls \"helper\", but dependsOn.hello doesn't list it.");

  const kept = await world.run(["try", "hello", "--keep", "adapted", "--yes"]);

  expect(kept.code, kept.stderr).toBe(0);
  expect(existsSync(join(clone, "skills/misc/helper/SKILL.md"))).toBe(true);
  expect(world.git(["branch", "--list", "try/*"], world.set.bare)).toBe("");
  expect(kept.stdout).toContain("Pushed main and deleted try/hello-adapted from origin.");
});

test("try refuses a skill with no upstream change or none in the set", async () => {
  const { world, clone } = await trialSet();

  const none = await world.run(["try", "hello"]);
  expect(none.code).toBe(1);
  expect(none.stderr).toBe("hello has no upstream changes since its pin, so there is nothing to try.\n\nNext: run `moro sync status`.\n");
  expect(trialBranches(world, clone)).toBe("");
  expect(existsSync(`${clone}-try`)).toBe(false);

  const unknown = await world.run(["try", "nope"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("nope is not an upstream skill in the set.");
});

test("install --from installs a candidate's copy; it refuses a folder that isn't a worktree of the clone; a rerun without it brings the project back to main", async () => {
  const { world, source, clone, trial } = await trialSet();
  source.commit({ "skills/hello/SKILL.md": wording("Upstream wording."), "skills/helper/SKILL.md": skillMd("helper") });
  expect((await world.run(["try", "hello"])).code).toBe(0);
  expect((await world.run(["add", source.url, "helper", "--yes"], { cwd: trial("hello") })).code).toBe(0);
  const installedHello = () => read(join(world.project, ".agents/skills/hello/SKILL.md"));

  const tried = await world.run(["install", "--from", trial("hello"), "--yes", "--pick", "hello", "helper"]);

  expect(tried.code, tried.stderr).toBe(0);
  expect(installedHello()).toBe(wording("Upstream wording."));
  expect(existsSync(join(world.project, ".agents/skills/helper"))).toBe(true);

  const refused = await world.run(["install", "--from", world.project, "--yes", "--pick", "hello"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toBe(
    `${world.project} isn't a worktree of the set's clone (${clone}).\n\nNext: run \`moro try <skill>\` in the set's clone, then pass one of the worktrees it prints.\n`,
  );

  const back = await world.run(["install", "--yes", "--pick", "hello"]);

  expect(back.code, back.stderr).toBe(0);
  expect(installedHello()).toBe(skillMd("hello"));
  // A skill only the trial held is the set's to remove.
  expect(existsSync(join(world.project, ".agents/skills/helper"))).toBe(false);
});
