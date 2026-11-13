import { existsSync, readFileSync } from "node:fs";
import type { Prompter } from "./prompter.js";
import { type Env, readLocations } from "./locations.js";

export interface Output {
  write(text: string): void;
}

/** Everything `moro` touches in the outside world, so tests can supply their own. */
export interface MoroIo {
  argv: string[];
  env: Env;
  cwd: string;
  stdout: Output;
  stderr: Output;
  prompter: Prompter;
}

export async function main(io: MoroIo): Promise<number> {
  const [command] = io.argv;
  switch (command) {
    case undefined:
      return status(io);
    case "--version":
      io.stdout.write(`${version()}\n`);
      return 0;
    default:
      io.stderr.write(`Unknown command: ${command}\n\nNext: run \`moro\` to see this machine's state\n`);
      return 1;
  }
}

function status(io: MoroIo): number {
  if (!existsSync(readLocations(io.env).machineFile)) {
    io.stdout.write("This machine isn't set up for moro's skill set.\n\nNext: run `moro setup`\n");
  }
  return 0;
}

function version(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  return pkg.version;
}
