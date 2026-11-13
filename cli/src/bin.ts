#!/usr/bin/env node
import { main } from "./main.js";
import { createTerminalPrompter } from "./prompter.js";

const prompter = createTerminalPrompter({ input: process.stdin, output: process.stdout });
const code = await main({
  argv: process.argv.slice(2),
  env: process.env,
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
  prompter,
});
prompter.close();
process.exitCode = code;
