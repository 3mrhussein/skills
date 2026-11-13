import { execFile } from "node:child_process";
import type { Env } from "./locations.js";

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
}

export type Git = (args: string[], cwd: string) => Promise<string>;

/** Runs git with the given environment, never prompting for credentials. */
export function gitRunner(env: Env): Git {
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: "0" };
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile("git", args, { cwd, env: gitEnv, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new GitError(args, stderr || error.message));
        else resolve(stdout.trim());
      });
    });
}
