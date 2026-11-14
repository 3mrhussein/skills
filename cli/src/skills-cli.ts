// The `skills` CLI, pinned as a dependency so every device and every test runs
// the same version.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Env } from "./locations.js";

const require = createRequire(import.meta.url);
const bin = join(dirname(require.resolve("skills/package.json")), "bin", "cli.mjs");

export interface SkillsResult {
  code: number;
  output: string;
}

export function runSkills(
  args: string[],
  options: { env: Env; cwd: string },
): Promise<SkillsResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (text: string) => (output += text));
    }
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}
