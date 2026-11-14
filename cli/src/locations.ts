// Where moro looks for things. Each comes from the environment so tests can
// point it at a temporary world; the defaults are the real ones.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type Env = Record<string, string | undefined>;

export interface Locations {
  home: string;
  /** moro's config folder, which holds the device file. */
  configDir: string;
  /** The device file: where this device's clone is. Never committed. */
  deviceFile: string;
  /** The `skills` CLI's user-level lock, where that CLI keeps it. */
  lockFile: string;
  /** The set's remote, as `git` and the `skills` CLI take it. Not the set's clone. */
  setRemote: string;
  /** The npm registry the update check reads. */
  npmRegistry: string;
}

export function readLocations(env: Env): Locations {
  const home = env.HOME || homedir();
  // The XDG spec says to ignore a relative XDG_CONFIG_HOME.
  const xdgConfig = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : undefined;
  const configDir = join(xdgConfig ?? join(home, ".config"), "moro");
  return {
    home,
    configDir,
    deviceFile: join(configDir, "config.json"),
    // The `skills` CLI reads XDG_STATE_HOME as given, relative or not.
    lockFile: env.XDG_STATE_HOME
      ? join(env.XDG_STATE_HOME, "skills", ".skill-lock.json")
      : join(home, ".agents", ".skill-lock.json"),
    setRemote: env.MORO_SET_REMOTE || "https://github.com/3mrhussein/skills.git",
    npmRegistry: env.MORO_NPM_REGISTRY || "https://registry.npmjs.org/",
  };
}
