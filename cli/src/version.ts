import { readFileSync } from "node:fs";

/** This moro's version, from its package.json. */
export const MORO_VERSION: string = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;
