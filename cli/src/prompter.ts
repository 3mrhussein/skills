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

export interface MultiSelectRequest {
  message: string;
  /**
   * A picked choice starts ticked, and Enter keeps the ticked ones; otherwise nothing starts picked.
   * A disabled choice is shown greyed out, with the reason, and can't be picked.
   */
  choices: (Choice & { disabled?: string; picked?: boolean })[];
}

export interface Prompter {
  select(request: SelectRequest): Promise<Answer>;
  /** The values picked, in the order the choices are listed. */
  multiSelect(request: MultiSelectRequest): Promise<string[]>;
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
    async multiSelect(request) {
      const out = streams.output;
      const pickable = request.choices.filter((choice) => !choice.disabled);
      const grey = (text: string) => ("isTTY" in out && out.isTTY ? `\x1b[2m${text}\x1b[22m` : text);
      const ticked = pickable.filter((choice) => choice.picked);
      const tick = (choice: { picked?: boolean }) => (ticked.length === 0 ? "" : choice.picked ? "[x] " : "[ ] ");
      out.write(`\n${request.message}\n`);
      let number = 0;
      for (const choice of request.choices) {
        if (choice.disabled) out.write(`${grey(`  -  ${choice.label} (${choice.disabled})`)}\n`);
        else out.write(`  ${++number}. ${tick(choice)}${choice.label}\n`);
      }
      const hint =
        ticked.length === 0
          ? { help: "or all; Enter takes none", retry: "or all, or press Enter for none" }
          : { help: "all or none; Enter keeps the ticked ones", retry: "all or none, or press Enter to keep the ticked ones" };
      out.write(`  Type the numbers to take (like 1 3 5-7), ${hint.help}.\n`);

      for (;;) {
        out.write("> ");
        const text = (await nextLine()).trim();
        if (text === "") return ticked.map((choice) => choice.value);
        if (text === "none") return [];
        const picked = parsePicks(text, pickable.length);
        if (picked) return pickable.filter((_, index) => picked.has(index + 1)).map((choice) => choice.value);
        out.write(`Pick numbers from 1 to ${pickable.length}, ${hint.retry}.\n`);
      }
    },
    close() {
      rl?.close();
    },
  };
}

/** A yes/no question; true for yes. */
export async function askYesNo(prompter: Prompter, message: string, recommended: "yes" | "no"): Promise<boolean> {
  const answer = await prompter.select({
    message,
    choices: [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ],
    recommended,
  });
  return "value" in answer && answer.value === "yes";
}

/** The choices in the order shown; fails when the recommended option isn't one of them. */
export function recommendedFirst(request: SelectRequest): Choice[] {
  const recommended = request.choices.find((choice) => choice.value === request.recommended);
  if (!recommended) throw new Error(`The recommended option isn't a choice: ${request.recommended}`);
  return [recommended, ...request.choices.filter((choice) => choice !== recommended)];
}

/** The numbers in `1 3 5-7` or `all`, or undefined when the text isn't that or names a number outside 1..count. */
function parsePicks(text: string, count: number): Set<number> | undefined {
  const picked = new Set<number>();
  if (text === "all") {
    for (let number = 1; number <= count; number++) picked.add(number);
    return picked;
  }
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return undefined;
    const first = Number(range[1]);
    const last = Number(range[2] ?? range[1]);
    if (first < 1 || last > count || first > last) return undefined;
    for (let number = first; number <= last; number++) picked.add(number);
  }
  return picked;
}
