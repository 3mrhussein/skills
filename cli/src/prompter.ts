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
  /** The value of the recommended choice. It is always listed first. Without one there is no default: Enter doesn't answer. */
  recommended?: string;
  /** When set, the owner may type an answer instead; the text names what to type. */
  allowTyped?: string;
}

export type Answer = { value: string } | { typed: string };

export interface MultiSelectRequest {
  message: string;
  /**
   * A picked choice starts ticked, and Enter keeps the ticked ones; otherwise nothing starts picked.
   * A disabled choice is shown greyed out, with the reason, and can't be picked.
   * Choices that share a `section` or `group` are listed under a header; list them together.
   * Typing a group's name picks the whole group, or drops it when it is already fully picked.
   */
  choices: (Choice & { disabled?: string; picked?: boolean; section?: string; group?: string })[];
  /** The choices are already on screen, numbered from 1 in this order with their ticks, so only the message and how to answer print. */
  listed?: boolean;
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
        const mark = index === 0 && request.recommended !== undefined ? " (recommended)" : "";
        out.write(`  ${index + 1}. ${choice.label}${mark}\n`);
      });
      if (request.allowTyped) out.write(`  Or type ${request.allowTyped}.\n`);

      for (;;) {
        out.write("> ");
        const text = (await nextLine()).trim();
        if (text === "" && request.recommended !== undefined) return { value: ordered[0]!.value };
        const isNumber = /^\d+$/.test(text);
        const picked = isNumber ? ordered[Number(text) - 1] : undefined;
        if (picked) return { value: picked.value };
        if (request.allowTyped && !isNumber) return { typed: text };
        out.write(`Pick a number from 1 to ${ordered.length}${request.recommended === undefined ? "" : ", or press Enter for 1"}.\n`);
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
      let section: string | undefined;
      let group: string | undefined;
      for (const choice of request.listed ? [] : request.choices) {
        if (choice.section !== undefined && choice.section !== section) {
          section = choice.section;
          group = undefined;
          out.write(`${section}\n`);
        }
        if (choice.group !== undefined && choice.group !== group) {
          group = choice.group;
          out.write(`  ${group}\n`);
        }
        if (choice.disabled) out.write(`${grey(`  -  ${choice.picked ? "[x] " : ""}${choice.label} (${choice.disabled})`)}\n`);
        else out.write(`  ${++number}. ${tick(choice)}${choice.label}\n`);
      }
      const hint =
        ticked.length === 0
          ? { help: "or all; Enter takes none", retry: "or all, or press Enter for none" }
          : { help: "all or none; Enter keeps the ticked ones", retry: "all or none, or press Enter to keep the ticked ones" };
      out.write(`  Type the numbers to take (like 1 3 5-7), ${hint.help}.\n`);
      const groups = [...new Set(pickable.flatMap((choice) => (choice.group === undefined ? [] : [choice.group])))];
      if (groups.length > 0) out.write("  Type a group's name to pick or drop the whole group.\n");

      for (;;) {
        out.write("> ");
        const text = (await nextLine()).trim();
        if (text === "") return ticked.map((choice) => choice.value);
        if (text === "none") return [];
        const picked = parsePicks(text, pickable.length, groups, pickable, ticked);
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
  if (request.recommended === undefined) return request.choices;
  const recommended = request.choices.find((choice) => choice.value === request.recommended);
  if (!recommended) throw new Error(`The recommended option isn't a choice: ${request.recommended}`);
  return [recommended, ...request.choices.filter((choice) => choice !== recommended)];
}

/** The numbers in `1 3 5-7` or `all`, or undefined when the text isn't that or names a number outside 1..count. */
function parsePicks(
  text: string,
  count: number,
  groups: string[],
  pickable: { value: string; group?: string }[],
  ticked: { value: string }[],
): Set<number> | undefined {
  const picked = new Set<number>();
  if (text === "all") {
    for (let number = 1; number <= count; number++) picked.add(number);
    return picked;
  }
  const parts = text.split(/[\s,]+/).filter(Boolean);
  const named = parts.filter((part) => groups.includes(part));
  const numbers = parts.filter((part) => !groups.includes(part));
  // Group names toggle on top of the numbers typed, or on the ticked ones when only groups are typed.
  if (named.length > 0) {
    const base = numbers.length > 0 ? parsePicks(numbers.join(" "), count, [], pickable, ticked) : undefined;
    if (numbers.length > 0 && !base) return undefined;
    const set = base ?? new Set(pickable.flatMap((choice, index) => (ticked.some((t) => t.value === choice.value) ? [index + 1] : [])));
    for (const name of named) {
      const members = pickable.flatMap((choice, index) => (choice.group === name ? [index + 1] : []));
      const all = members.every((member) => set.has(member));
      for (const member of members) {
        if (all) set.delete(member);
        else set.add(member);
      }
    }
    return set;
  }
  for (const part of numbers) {
    const range = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!range) return undefined;
    const first = Number(range[1]);
    const last = Number(range[2] ?? range[1]);
    if (first < 1 || last > count || first > last) return undefined;
    for (let number = first; number <= last; number++) picked.add(number);
  }
  return picked;
}
