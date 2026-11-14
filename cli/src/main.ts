import { add } from "./add.js";
import type { Prompter } from "./prompter.js";
import { type Env, readLocations } from "./locations.js";
import { bootstrap } from "./bootstrap.js";
import { install } from "./install.js";
import { readDevice } from "./device.js";
import { sync } from "./sync.js";
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
      requireDevice(io);
      return status(io);
    case "add":
      requireDevice(io);
      return add(io, args);
    case "install":
      requireDevice(io);
      return install(io, args);
    case "sync":
      requireDevice(io);
      return sync(io, args);
    case "bootstrap":
      return bootstrap(io, args);
    case "--version":
      io.stdout.write(`${MORO_VERSION}\n`);
      return 0;
    default:
      io.stderr.write(`Unknown command: ${command}\n\nNext: run \`moro\` to see this machine's state\n`);
      return 1;
  }
}

/** Every command but `bootstrap` and `--version` needs the device file, which `./install.sh` writes. */
function requireDevice(io: MoroIo): void {
  if (!readDevice(readLocations(io.env).deviceFile)) {
    throw new UserError("This device has no device file, so moro doesn't know where the set's clone is.\n\nNext: run ./install.sh in the set's clone.");
  }
}

function status(_io: MoroIo): number {
  return 0;
}
