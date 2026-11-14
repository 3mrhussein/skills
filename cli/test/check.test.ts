import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, type Files, writeFiles } from "./world.js";

/** A `SKILL.md` whose body is `body`; `userInvoked` adds `disable-model-invocation: true`. */
function skill(name: string, body = `The ${name} skill.`, { userInvoked = false } = {}): string {
  const invocation = userInvoked ? "disable-model-invocation: true\n" : "";
  return `---\nname: ${name}\ndescription: Use for ${name}.\n${invocation}---\n\n${body}\n`;
}

function manifest(fields: { recommended?: string[]; required?: string[]; dependsOn?: Record<string, string[]> }): string {
  return `${JSON.stringify({ moro: "0.2.0", sources: {}, skills: {}, recommended: [], dependsOn: {}, ...fields }, null, 2)}\n`;
}

/** A device whose clone holds `files`, committed. */
function setWith(files: Files) {
  const world = createWorld({ set: files });
  const clone = world.cloneSet();
  world.recordClone(clone);
  return { world, clone };
}

/** One set with one of each finding, and calls that are fine. */
const brokenSet: Files = {
  "manifest.json": manifest({
    recommended: ["skills/engineering/ask-moro", "skills/engineering/tdd", "skills/engineering/grilling", "skills.local/*"],
    required: ["skills/engineering/ask-moro", "skills/engineering/gone"],
    dependsOn: { tdd: ["codebase-design"], implement: ["tdd", "grilling"] },
  }),
  "skills/engineering/ask-moro/SKILL.md": skill("ask-moro", "- `/tdd`: build test-first.\n- Anything else: read the installed skills."),
  "skills/engineering/tdd/SKILL.md": skill(
    "tdd",
    'For the seam, call the Skill tool with "codebase-design". If a test fails oddly, call the Skill tool with `diagnosing-bugs`.',
  ),
  "skills/engineering/codebase-design/SKILL.md": skill("codebase-design", 'Deep modules. Like "grilling" says, ask one thing at a time.'),
  "skills/engineering/grilling/SKILL.md": skill("grilling"),
  "skills/engineering/implement/SKILL.md": skill(
    "implement",
    'Call the Skill tool twice, for "tdd" and "setup-moro-skills". Then review.',
  ),
  "skills/engineering/setup-moro-skills/SKILL.md": skill("setup-moro-skills", "Set up a project.", { userInvoked: true }),
};

test("check reads the clone's skills and manifest, reports each finding on one line and exits 1", async () => {
  const { world } = setWith(brokenSet);

  const result = await world.run(["check"]);

  expect(result.code).toBe(1);
  expect(result.stdout).toContain("  implement -> tdd, setup-moro-skills\n");
  expect(result.stdout).toContain("  tdd -> codebase-design, diagnosing-bugs\n");
  const findings = [
    'tdd calls "diagnosing-bugs", which isn\'t in the set.',
    'implement calls "setup-moro-skills", which is user-invoked (disable-model-invocation: true), so no skill can call it.',
    'tdd calls "diagnosing-bugs", but dependsOn.tdd doesn\'t list it.',
    'implement calls "setup-moro-skills", but dependsOn.implement doesn\'t list it.',
    'dependsOn.implement lists "grilling", but implement never calls it.',
    "required skills/engineering/gone isn't in the set.",
    "ask-moro never names /grilling, a recommended skill.",
  ];
  for (const finding of findings) expect(result.stdout).toContain(`\n  ${finding}\n`);
  expect(result.stdout.match(/^ {2}\S.*\.$/gm)).toHaveLength(findings.length);
  expect(result.stdout).toMatch(/\nNext: fix each finding in the skill's text or in manifest\.json, then rerun `moro check`\.\n$/);
});

test("router coverage looks only at recommended skills, and only Skill-tool sentences are calls", async () => {
  const { world } = setWith(brokenSet);

  const result = await world.run(["check"]);

  // codebase-design isn't recommended, so ask-moro needn't name it; its quoted "grilling" isn't a call.
  expect(result.stdout).not.toContain("/codebase-design");
  expect(result.stdout).not.toContain("codebase-design -> ");
  expect(result.stdout).not.toContain("/implement");
});

test("a set whose skills fit together exits 0 and names the next step", async () => {
  const { world, clone } = setWith({
    "manifest.json": manifest({ recommended: ["skills/engineering/ask-moro", "skills/engineering/tdd"], dependsOn: { tdd: ["codebase-design"] } }),
    "skills/engineering/ask-moro/SKILL.md": skill("ask-moro", "- `/tdd`: build test-first."),
    "skills/engineering/tdd/SKILL.md": skill("tdd", 'Call the Skill tool with "codebase-design".'),
    "skills/engineering/codebase-design/SKILL.md": skill("codebase-design"),
  });

  const result = await world.run(["check"], { cwd: world.root });

  expect(result.code, result.stdout).toBe(0);
  expect(result.stdout).toContain(`Workflow check of the set at ${clone}: 3 skills.`);
  expect(result.stdout).toContain("Findings: none.");
  expect(result.stdout).toMatch(/\nNext: run `moro sync status` to check upstream skills\.\n$/);
});

test("check on a folder without a manifest reads every SKILL.md under it and reports only the calls", async () => {
  const world = createWorld();
  world.recordClone(world.cloneSet());
  const folder = join(world.root, "matt");
  writeFiles(folder, {
    "skills/engineering/tdd/SKILL.md": skill("tdd", 'Call the Skill tool with "codebase-design".'),
    "skills/engineering/codebase-design/SKILL.md": skill("codebase-design"),
    "skills/misc/grill-me/SKILL.md": skill("grill-me", 'Call the Skill tool with "grilling".'),
    "skills/misc/setup/SKILL.md": skill("setup", "Set up.", { userInvoked: true }),
    "skills/misc/router/SKILL.md": skill("router", 'Then call the Skill tool with "setup".'),
    "node_modules/pkg/SKILL.md": skill("pkg", 'Call the Skill tool with "nowhere".'),
  });

  const result = await world.run(["check", "matt"], { cwd: world.root });

  expect(result.code).toBe(1);
  expect(result.stdout).toContain(`Workflow check of ${folder}: 5 skills.`);
  expect(result.stdout).toContain('  grill-me calls "grilling", which isn\'t in this folder.\n');
  expect(result.stdout).toContain('  router calls "setup", which is user-invoked');
  expect(result.stdout).not.toContain("dependsOn");
  expect(result.stdout).not.toContain("nowhere");
});

test("a folder that doesn't exist stops with a next step", async () => {
  const { world } = setWith(brokenSet);

  const result = await world.run(["check", "nowhere"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`${join(world.project, "nowhere")} isn't a folder.`);
  expect(result.stderr).toContain("Next: ");
});

/** implement -> tdd -> codebase-design, improve -> codebase-design, wayfinder -> implement. */
const chain: Files = {
  "skills/engineering/codebase-design/SKILL.md": skill("codebase-design"),
  "skills/engineering/tdd/SKILL.md": skill("tdd", 'Call the Skill tool with "codebase-design".'),
  "skills/engineering/improve/SKILL.md": skill("improve", 'Call the Skill tool with "codebase-design".'),
  "skills/engineering/implement/SKILL.md": skill("implement", 'Call the Skill tool with "tdd".'),
  "skills/engineering/wayfinder/SKILL.md": skill("wayfinder", 'Call the Skill tool with "implement".'),
  "skills/engineering/grilling/SKILL.md": skill("grilling"),
};

test("--impact lists direct callers, then indirect ones with the path", async () => {
  const { world } = setWith({ "manifest.json": manifest({}), ...chain });

  const result = await world.run(["check", "--impact", "codebase-design"]);

  const impact = result.stdout.slice(result.stdout.indexOf("Impact of a change to codebase-design:"));
  expect(impact).toMatch(
    /^Impact of a change to codebase-design:\n {2}direct {4}improve\n {2}direct {4}tdd\n {2}indirect {2}implement -> tdd -> codebase-design\n {2}indirect {2}wayfinder -> implement -> tdd -> codebase-design\n/,
  );
  expect(result.stdout).not.toMatch(/direct.*grilling/);

  const lonely = await world.run(["check", "--impact", "grilling"]);
  expect(lonely.stdout).toContain("Impact of a change to grilling: no skill calls it.");

  const unknown = await world.run(["check", "--impact", "nope"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("nope isn't a skill in the set.");
});

test("--json prints the calls, findings and impact for manage-moro-skills, with the same exit code", async () => {
  const { world } = setWith({
    "manifest.json": manifest({ dependsOn: { tdd: ["codebase-design"] } }),
    ...chain,
  });

  const result = await world.run(["check", "--json", "--impact", "codebase-design"]);

  expect(result.code).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report.calls).toMatchObject({ tdd: ["codebase-design"], implement: ["tdd"], grilling: [] });
  expect(report.findings).toContainEqual({
    kind: "undeclared",
    skill: "implement",
    target: "tdd",
    message: 'implement calls "tdd", but dependsOn.implement doesn\'t list it.',
  });
  expect(report.impact).toEqual([
    { skill: "improve", depth: 1, via: ["improve", "codebase-design"] },
    { skill: "tdd", depth: 1, via: ["tdd", "codebase-design"] },
    { skill: "implement", depth: 2, via: ["implement", "tdd", "codebase-design"] },
    { skill: "wayfinder", depth: 3, via: ["wayfinder", "implement", "tdd", "codebase-design"] },
  ]);

  const plain = JSON.parse((await world.run(["check", "--json"])).stdout);
  expect(plain.impact).toBeNull();
});

test("check reads local-only skills too, and a trial worktree's own manifest", async () => {
  const { world, clone } = setWith({
    "manifest.json": manifest({ dependsOn: { tdd: ["codebase-design"] } }),
    "skills/engineering/tdd/SKILL.md": skill("tdd", 'Call the Skill tool with "codebase-design".'),
    "skills/engineering/codebase-design/SKILL.md": skill("codebase-design"),
  });
  mkdirSync(join(clone, "skills.local/notes"), { recursive: true });
  writeFileSync(join(clone, "skills.local/notes/SKILL.md"), skill("notes", 'Call the Skill tool with "tdd".'));
  const trial = join(world.root, "skills-try", "tdd-adapted");
  world.git(["worktree", "add", "-q", "-b", "try/tdd-adapted", trial], clone);
  writeFileSync(join(trial, "manifest.json"), manifest({ dependsOn: {} }));

  const set = await world.run(["check"]);
  expect(set.stdout).toContain("  notes -> tdd\n");
  expect(set.stdout).toContain('notes calls "tdd", but dependsOn.notes doesn\'t list it.');

  const tried = await world.run(["check", trial]);
  expect(tried.stdout).toContain(`Workflow check of the set at ${trial}: 2 skills.`);
  expect(tried.stdout).toContain('tdd calls "codebase-design", but dependsOn.tdd doesn\'t list it.');
});

test("a /skill the text tells the agent to run, and a ../skill/SKILL.md it reads, are calls; a /skill for the owner to run isn't", async () => {
  const { world } = setWith({
    "manifest.json": manifest({ dependsOn: { "loop-me": ["grilling"] } }),
    "skills/in-progress/loop-me/SKILL.md": skill("loop-me", "Run a stateful `/grilling` session whose only output is specs."),
    "skills/in-progress/chief/SKILL.md": skill(
      "chief",
      "- **Retro** (`../retro/SKILL.md`): run a retro now and then.\n- Write a spec with `../to-spec/SKILL.md`.\n\nIf not, tell the user to run `/setup-moro-skills`. Used by `/loop-me`.",
    ),
    "skills/engineering/grilling/SKILL.md": skill("grilling"),
    "skills/engineering/retro/SKILL.md": skill("retro", "Look back.", { userInvoked: true }),
    "skills/engineering/to-spec/SKILL.md": skill("to-spec"),
    "skills/engineering/setup-moro-skills/SKILL.md": skill("setup-moro-skills", "Set up.", { userInvoked: true }),
  });

  const result = await world.run(["check"]);

  expect(result.stdout).toContain("  loop-me -> grilling\n");
  expect(result.stdout).toContain("  chief -> retro, to-spec\n");
  expect(result.stdout).toContain('\n  chief calls "retro", but dependsOn.chief doesn\'t list it.\n');
  expect(result.stdout).toContain('\n  chief calls "to-spec", but dependsOn.chief doesn\'t list it.\n');
  // Reading a skill's file works whatever its invocation setting, and the owner's /skills aren't calls.
  expect(result.stdout).not.toContain("user-invoked");
  expect(result.stdout).not.toContain("setup-moro-skills");
  expect(result.stdout).not.toContain('calls "loop-me"');
});
