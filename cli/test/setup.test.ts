import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, skillMd, type World, writeFiles } from "./world.js";

/** A set with three skills in `skills/` and one in `work/`. */
function worldWithSet(): World {
  return createWorld({
    set: {
      "skills/alpha/SKILL.md": skillMd("alpha"),
      "skills/beta/SKILL.md": skillMd("beta"),
      "skills/gamma/SKILL.md": skillMd("gamma"),
      "work/deploy/SKILL.md": skillMd("deploy"),
    },
  });
}

/** Names in the lock installed from the set. */
function installedFromSet(world: World): string[] {
  const lock = world.readLock();
  return Object.entries(lock?.skills ?? {})
    .filter(([, entry]) => entry.sourceUrl === world.set.url)
    .map(([name]) => name)
    .sort();
}

function linked(world: World, name: string): boolean {
  return existsSync(join(world.home, ".claude", "skills", name, "SKILL.md"));
}

const skillChoices = (picked: Record<string, boolean>) =>
  Object.entries(picked).map(([name, isPicked]) => ({ value: name, label: name, ...(isPicked ? { picked: true } : {}) }));

test("a first setup checks git, offers the global CLI, installs the picked skills and records the left-out ones", async () => {
  const world = worldWithSet();

  const result = await world.run(["setup"], { answers: ["yes", ["alpha", "beta"]] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain(
    "No skills are installed at user level. moro hasn't set this machine up, so it isn't a work machine yet. No clone of the set is recorded.\n",
  );
  expect(result.stdout).toContain("Git can read the set");
  expect(result.prompts).toEqual([
    {
      message: "moro isn't on your PATH, so hints saying `moro …` won't run. Install it with `npm i -g @3mrhussein/moro`?",
      choices: [
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ],
      recommended: "yes",
    },
    {
      message: "Which of the set's skills should this machine have?",
      choices: skillChoices({ alpha: true, beta: true, gamma: true }),
    },
  ]);
  expect(world.npmCalls()).toEqual(["i -g @3mrhussein/moro"]);
  expect(installedFromSet(world)).toEqual(["alpha", "beta"]);
  expect(linked(world, "alpha")).toBe(true);
  expect(linked(world, "gamma")).toBe(false);
  expect(linked(world, "deploy")).toBe(false);
  expect(world.readMachineFile()).toEqual({ work: false, leftOut: ["gamma"], setRepo: null });
  expect(result.stdout).toContain(
    [
      "Installed: alpha, beta.",
      "Left out: gamma.",
      "",
      "Next: open a project and run `/setup-moro-skills`",
      "",
    ].join("\n"),
  );
});

test("the per-machine file sits in the config folder, outside the project's git", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();

  const result = await world.run(["setup", "--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(world.readMachineFile()).toEqual({ work: false, leftOut: [], setRepo: null });
  expect(world.git(["status", "--porcelain"], world.project)).toBe("");
  expect((await world.run([])).stdout).not.toContain("isn't set up");
});

test("a rerun on a current machine is all defaults and ends Up to date.", async () => {
  const world = worldWithSet();
  await world.run(["setup"], { answers: ["yes", ["alpha", "beta"]] });

  const result = await world.run(["setup"], { answers: [["alpha", "beta"]] });

  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toContain("2 skills are installed at user level, both from the set. This isn't a work machine.");
  expect(result.prompts).toEqual([
    {
      message: "Which of the set's skills should this machine have?",
      choices: skillChoices({ alpha: true, beta: true, gamma: false }),
    },
  ]);
  expect(world.npmCalls()).toEqual(["i -g @3mrhussein/moro"]);
  expect(result.stdout.endsWith("Up to date.\n")).toBe(true);
  expect(world.readMachineFile()).toEqual({ work: false, leftOut: ["gamma"], setRepo: null });
});

test("a rerun can bring a left-out skill back and leave an installed one out", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();
  await world.run(["setup"], { answers: [["alpha", "beta"]] });

  const result = await world.run(["setup"], { answers: [["beta", "gamma"]] });

  expect(result.code, result.stderr).toBe(0);
  expect(installedFromSet(world)).toEqual(["beta", "gamma"]);
  expect(linked(world, "alpha")).toBe(false);
  expect(world.readMachineFile()).toEqual({ work: false, leftOut: ["alpha"], setRepo: null });
  expect(result.stdout).toContain("Installed: gamma.\nRemoved: alpha.\nLeft out: alpha.\n");
  expect(result.stdout).not.toContain("Next: open a project");
});

test("answering no to the global CLI installs nothing with npm and carries on", async () => {
  const world = worldWithSet();

  const result = await world.run(["setup"], { answers: ["no", ["alpha", "beta", "gamma"]] });

  expect(result.code, result.stderr).toBe(0);
  expect(world.npmCalls()).toEqual([]);
  expect(installedFromSet(world)).toEqual(["alpha", "beta", "gamma"]);
});

test("with moro on the PATH, setup doesn't ask about the global CLI", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();

  const result = await world.run(["setup"], { answers: [["alpha"]] });

  expect(result.prompts.map((prompt) => prompt.message)).toEqual(["Which of the set's skills should this machine have?"]);
  expect(world.npmCalls()).toEqual([]);
});

test("the state names what's installed and from where", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();
  const other = world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  expect((await world.skills(["add", other.url, "-g", "-y"])).code).toBe(0);
  await world.skills(["add", world.set.url, "-g", "-y", "--skill", "alpha"]);
  const source = world.readLock()!.skills.hello!.source;

  const result = await world.run(["setup", "--yes"]);

  expect(result.stdout).toContain(`2 skills are installed at user level: 1 from the set and 1 from ${source}.`);
  expect(world.readLock()!.skills.hello).toBeDefined();
});

test("when git can't read the set, setup stops with the checklist and changes nothing", async () => {
  const world = worldWithSet();
  world.env.MORO_SET_REMOTE = "https://git.moro.test/3mrhussein/missing.git";

  for (const argv of [["setup"], ["setup", "--yes"]]) {
    const result = await world.run(argv);

    expect(result.code).not.toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stderr).toContain("Git can't read the set at https://git.moro.test/3mrhussein/missing.git");
    expect(result.stderr).toContain("a GitHub token in git's credential helper for github.com");
    expect(result.stderr).toContain("an SSH key on the 3mrhussein GitHub account");
    expect(result.stderr).toContain("Machine setup never changes git credentials.");
    expect(result.stderr).toContain("then rerun `moro setup`");
  }
  expect(world.readMachineFile()).toBeUndefined();
  expect(world.readLock()).toBeUndefined();
  expect(world.npmCalls()).toEqual([]);
});

test("--yes takes each recommended answer: the global CLI and every skill", async () => {
  const world = worldWithSet();

  const result = await world.run(["setup", "--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(world.npmCalls()).toEqual(["i -g @3mrhussein/moro"]);
  expect(installedFromSet(world)).toEqual(["alpha", "beta", "gamma"]);
  expect(world.readMachineFile()).toEqual({ work: false, leftOut: [], setRepo: null });
  expect(result.stdout).toContain("Installed: alpha, beta, gamma.\n\nNext: open a project and run `/setup-moro-skills`\n");
});

test("--yes keeps the machine's left-out skills left out, and a current machine is Up to date.", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();
  await world.run(["setup"], { answers: [["alpha"]] });

  const result = await world.run(["setup", "--yes"]);

  expect(installedFromSet(world)).toEqual(["alpha"]);
  expect(result.stdout.endsWith("Up to date.\n")).toBe(true);
});

test("--leave-out leaves the named skills out, and removes them when installed", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();
  await world.run(["setup", "--yes"]);

  const result = await world.run(["setup", "--yes", "--leave-out", "beta", "gamma"]);

  expect(result.code, result.stderr).toBe(0);
  expect(installedFromSet(world)).toEqual(["alpha"]);
  expect(world.readMachineFile()).toEqual({ work: false, leftOut: ["beta", "gamma"], setRepo: null });
  expect(result.stdout).toContain("Removed: beta, gamma.\nLeft out: beta, gamma.\n");
});

test("--leave-out answers the skills step, so it isn't asked", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();

  const result = await world.run(["setup", "--leave-out", "alpha"]);

  expect(result.code, result.stderr).toBe(0);
  expect(result.prompts).toEqual([]);
  expect(installedFromSet(world)).toEqual(["beta", "gamma"]);
});

test("--leave-out of a skill the set doesn't hold stops before changing anything", async () => {
  const world = worldWithSet();

  const result = await world.run(["setup", "--yes", "--leave-out", "nope"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("The set has no skill named nope.");
  expect(world.npmCalls()).toEqual([]);
  expect(world.readLock()).toBeUndefined();
  expect(world.readMachineFile()).toBeUndefined();
});

test("an unknown option fails with the usage", async () => {
  const world = worldWithSet();

  const result = await world.run(["setup", "--frobnicate"]);

  expect(result.code).toBe(1);
  expect(result.stderr).toContain("Unknown option: --frobnicate");
  expect(result.stderr).toContain("moro setup [--yes] [--leave-out <skill…>]");
});

test("skills from other sources keep their lock entries and folders", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();
  const other = world.source("acme/tools", { "skills/hello/SKILL.md": skillMd("hello") });
  await world.skills(["add", other.url, "-g", "-y"]);

  await world.run(["setup", "--yes", "--leave-out", "alpha"]);

  expect(world.readLock()!.skills.hello).toBeDefined();
  expect(readFileSync(join(world.home, ".claude", "skills", "hello", "SKILL.md"), "utf8")).toBe(skillMd("hello"));
});

test("XDG_STATE_HOME moves the lock moro reads, as it moves the skills CLI's", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();
  world.env.XDG_STATE_HOME = join(world.root, "xdg-state");
  await world.skills(["add", world.set.url, "-g", "-y", "--skill", "alpha"]);

  const result = await world.run(["setup", "--yes"]);

  expect(result.stdout).toContain("1 skill is installed at user level, from the set.");
  expect(result.stdout).toContain("Installed: beta, gamma.");
  expect(existsSync(join(world.root, "xdg-state", "skills", ".skill-lock.json"))).toBe(true);
});

test("--leave-out replaces the machine's left-out skills, so it can bring one back", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();
  await world.run(["setup", "--yes", "--leave-out", "gamma"]);

  const result = await world.run(["setup", "--yes", "--leave-out", "beta"]);

  expect(result.code, result.stderr).toBe(0);
  expect(installedFromSet(world)).toEqual(["alpha", "gamma"]);
  expect(world.readMachineFile()).toEqual({ work: false, leftOut: ["beta"], setRepo: null });
  expect(result.stdout).toContain("Installed: gamma.\nRemoved: beta.\nLeft out: beta.\n");
});

test("a moro that only npx or an npm script put on the PATH doesn't count as installed", async () => {
  const world = worldWithSet();
  const npxBin = join(world.root, "npm-cache", "_npx", "abc123", "node_modules", ".bin");
  writeFiles(npxBin, { moro: { content: "#!/bin/sh\n", mode: 0o755 } });
  world.env.PATH = `${npxBin}:${world.env.PATH}`;

  const result = await world.run(["setup"], { answers: ["yes", ["alpha", "beta", "gamma"]] });

  expect(result.code, result.stderr).toBe(0);
  expect(world.npmCalls()).toEqual(["i -g @3mrhussein/moro"]);
});

test("setup keeps keys in the per-machine file that it doesn't know", async () => {
  const world = worldWithSet();
  world.putMoroOnPath();
  writeFiles(world.home, {
    ".config/moro/config.json": JSON.stringify({ work: false, leftOut: [], setRepo: null, trial: "/somewhere" }),
  });

  await world.run(["setup", "--yes"]);

  expect(world.readMachineFile()).toEqual({ work: false, leftOut: [], setRepo: null, trial: "/somewhere" });
});
