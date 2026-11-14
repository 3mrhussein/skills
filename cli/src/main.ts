import { existsSync } from "node:fs";
import { add } from "./add.js";
import type { Prompter } from "./prompter.js";
import { type Env, readLocations } from "./locations.js";
import { setup } from "./setup.js";
import { UserError } from "./user-error.js";
import { MORO_VERSION } from "./version.js";

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
  try {
    return await run(io);
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return 1;
  }
}

async function run(io: MoroIo): Promise<number> {
  const [command, ...args] = io.argv;
  switch (command) {
    case undefined:
      return status(io);
    case "add":
      return add(io, args);
    case "setup":
      return setup(io, args);
    case "--version":
      io.stdout.write(`${MORO_VERSION}\n`);
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
