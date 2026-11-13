import { PassThrough } from "node:stream";
import { expect, test } from "vitest";
import { createTerminalPrompter } from "../src/prompter.js";
import type { SelectRequest } from "../src/prompter.js";

const scope: SelectRequest = {
  message: "Where should the set go?",
  choices: [
    { value: "user", label: "User level (all projects)" },
    { value: "trial", label: "This project only (trial)" },
    { value: "none", label: "Nowhere yet" },
  ],
  recommended: "trial",
};

function terminal(typed: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk: Buffer) => (shown += chunk.toString()));
  input.end(typed);
  return { prompter: createTerminalPrompter({ input, output }), shown: () => shown };
}

test("the recommended option is listed first and Enter takes it", async () => {
  const { prompter, shown } = terminal("\n");

  const answer = await prompter.select(scope);

  expect(answer).toEqual({ value: "trial" });
  expect(shown()).toContain(
    [
      "Where should the set go?",
      "  1. This project only (trial) (recommended)",
      "  2. User level (all projects)",
      "  3. Nowhere yet",
    ].join("\n"),
  );
});

test("a number picks the option shown at that number", async () => {
  const { prompter } = terminal("2\n");

  expect(await prompter.select(scope)).toEqual({ value: "user" });
});

test("text that isn't a number is a typed answer when the prompt allows one", async () => {
  const { prompter, shown } = terminal("  my-own-key \n");

  const answer = await prompter.select({ ...scope, allowTyped: "another key" });

  expect(answer).toEqual({ typed: "my-own-key" });
  expect(shown()).toContain("Or type another key.");
});

test("without a typed answer allowed, anything but a listed number asks again", async () => {
  const { prompter, shown } = terminal("maybe\n7\n3\n");

  const answer = await prompter.select(scope);

  expect(answer).toEqual({ value: "none" });
  expect(shown().match(/Pick a number from 1 to 3, or press Enter for 1\./g)).toHaveLength(2);
});
