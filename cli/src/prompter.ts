// Every question moro asks is a selection: a list with the recommended option
// first, and optionally a typed answer instead.
import { createInterface, type Interface } from "node:readline";

export interface Choice {
  value: string;
  label: string;
}

export interface SelectRequest {
  message: string;
  choices: Choice[];
  /** The value of the recommended choice. It is always listed first. */
  recommended: string;
  /** When set, the owner may type an answer instead; the text names what to type. */
  allowTyped?: string;
}

export type Answer = { value: string } | { typed: string };

export interface Prompter {
  select(request: SelectRequest): Promise<Answer>;
}

/** The prompter for a real terminal: a numbered list, Enter for the recommended option. */
export function createTerminalPrompter(streams: {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}): Prompter & { close(): void } {
  let lines: AsyncIterator<string> | undefined;
  let rl: Interface | undefined;
  const nextLine = async (): Promise<string> => {
    rl ??= createInterface({ input: streams.input, terminal: false });
    lines ??= rl[Symbol.asyncIterator]();
    const line = await lines.next();
    if (line.done) throw new Error("No answer: the input closed.");
    return line.value;
  };

  return {
    async select(request) {
      const ordered = recommendedFirst(request);
      const out = streams.output;
      out.write(`\n${request.message}\n`);
      ordered.forEach((choice, index) => {
        const mark = index === 0 ? " (recommended)" : "";
        out.write(`  ${index + 1}. ${choice.label}${mark}\n`);
      });
      if (request.allowTyped) out.write(`  Or type ${request.allowTyped}.\n`);

      for (;;) {
        out.write("> ");
        const text = (await nextLine()).trim();
        if (text === "") return { value: ordered[0]!.value };
        const isNumber = /^\d+$/.test(text);
        const picked = isNumber ? ordered[Number(text) - 1] : undefined;
        if (picked) return { value: picked.value };
        if (request.allowTyped && !isNumber) return { typed: text };
        out.write(`Pick a number from 1 to ${ordered.length}, or press Enter for 1.\n`);
      }
    },
    close() {
      rl?.close();
    },
  };
}

/** The choices in the order shown; fails when the recommended option isn't one of them. */
export function recommendedFirst(request: SelectRequest): Choice[] {
  const recommended = request.choices.find((choice) => choice.value === request.recommended);
  if (!recommended) throw new Error(`The recommended option isn't a choice: ${request.recommended}`);
  return [recommended, ...request.choices.filter((choice) => choice !== recommended)];
}
