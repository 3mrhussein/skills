// Seam 2: `./install.sh` run against a temporary clone and home, with a fake `npm`
// (and fake `node` or `git` where the test is about those checks).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { createWorld, skillMd, type World } from "./world.js";

const INSTALL_SH = readFileSync(new URL("../../install.sh", import.meta.url), "utf8");
const SYSTEM = "/usr/bin:/bin";

function script(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A world whose set holds install.sh, and a bin folder with a fake npm that logs its calls. */
function installWorld() {
  const world = createWorld({
    set: {
      "install.sh": { content: INSTALL_SH, mode: 0o755 },
      "cli/package.json": "{}\n",
      "skills/meta/setup-moro-skills/SKILL.md": skillMd("setup-moro-skills"),
    },
  });
  const bin = join(world.root, "bin");
  const log = join(world.root, "calls.log");
  const globalBin = join(world.root, "global", "bin");
  // `npm link` puts a `moro` that logs its arguments into the global bin, as the real one would.
  script(
    join(bin, "npm"),
    `echo "npm $*" >> "${log}"
case "$1" in
  run) mkdir -p dist; echo built > dist/bin.js ;;
  link) mkdir -p "${globalBin}"
        printf '#!/bin/sh\\necho "moro $*" >> "${log}"\\n' > "${globalBin}/moro"
        chmod +x "${globalBin}/moro" ;;
  prefix) echo "${join(world.root, "global")}" ;;
esac`,
  );
  // Only node itself from its folder: a `moro` that `npm link` put there must not stand in for the fake one.
  const nodeBin = join(world.root, "node-bin");
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, "node"));
  return { world, bin, log, path: `${bin}:${nodeBin}:${SYSTEM}` };
}

function install(world: World, path: string, args: string[] = []) {
  const clone = world.clone;
  const result = spawnSync(join(clone, "install.sh"), args, {
    cwd: world.project,
    env: { ...world.env, PATH: path },
    encoding: "utf8",
  });
  return { clone, code: result.status, stderr: result.stderr };
}

const calls = (log: string) => readFileSync(log, "utf8").trim().split("\n");
const builtFrom = (clone: string) => readFileSync(join(clone, "cli", "dist", "built-from"), "utf8").trim();

test("it builds the CLI in the clone, links it, records the commit and hands over to moro bootstrap with its flags", () => {
  const { world, log, path } = installWorld();

  const result = install(world, path, ["--yes"]);

  expect(result.code, result.stderr).toBe(0);
  expect(calls(log)).toEqual(["npm ci", "npm run build", "npm link", "npm prefix -g", "moro bootstrap --yes"]);
  expect(builtFrom(result.clone)).toBe(world.set.head());
});

test("a rerun after a pull rebuilds, relinks and records the new commit", () => {
  const { world, log, path } = installWorld();
  install(world, path);
  const pulled = world.set.commit({ "notes.txt": "pulled\n" });
  world.git(["pull", "-q"], world.clone);

  const result = install(world, path);

  expect(result.code, result.stderr).toBe(0);
  expect(calls(log).slice(5)).toEqual(["npm ci", "npm run build", "npm link", "npm prefix -g", "moro bootstrap"]);
  expect(builtFrom(result.clone)).toBe(pulled);
});

test("without node it stops, names node and runs nothing", () => {
  const { world, bin, log } = installWorld();
  const gitDir = join(world.root, "git-only");
  script(join(gitDir, "git"), `exec /usr/bin/git "$@"`);

  const result = install(world, `${gitDir}:${bin}`);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("node");
  expect(existsSync(log)).toBe(false);
});

test("with node older than 22.20 it stops and says which version it found", () => {
  const { world, bin, log } = installWorld();
  const oldNode = join(world.root, "old-node");
  script(join(oldNode, "node"), `echo 22.19.0`);

  const result = install(world, `${oldNode}:${bin}:${SYSTEM}`);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("22.19.0");
  expect(existsSync(log)).toBe(false);
});

test("without git it stops, names git and runs nothing", () => {
  const { world, bin, log } = installWorld();
  const nodeDir = join(world.root, "node-only");
  script(join(nodeDir, "node"), `echo 24.0.0`);

  // The clone is made with the world's git first; the script itself then sees no git.
  const result = install(world, `${nodeDir}:${bin}`);

  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("git");
  expect(existsSync(log)).toBe(false);
});
