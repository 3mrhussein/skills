// The render: a source's skill folder at a commit, with the source's rename
// rules applied and `name` set to the skill's key. Intake, sync and
// re-rendering all share it.
import { setFrontmatterName } from "./frontmatter.js";
import type { RenameRule } from "./manifest.js";
import type { SkillFile } from "./source.js";

export function render(files: SkillFile[], rules: RenameRule[], key: string): SkillFile[] {
  return files.map((file) => {
    const path = applyRules(file.path, rules);
    if ("symlink" in file || isBinary(file.content)) return { ...file, path };
    const original = file.content.toString("utf8");
    let text = applyRules(original, rules);
    if (path === "SKILL.md") text = setFrontmatterName(text, key);
    // Untouched files keep their bytes, even when they aren't UTF-8.
    return { ...file, path, content: text === original ? file.content : Buffer.from(text, "utf8") };
  });
}

/** The skill's key before the owner changes it: its frontmatter `name`, renamed. */
export function renderName(name: string, rules: RenameRule[]): string {
  return applyRules(name, rules);
}

/**
 * Applies each rule in order, literally and whole-word: a match can't touch a
 * letter, digit or underscore on a side where the rule itself starts or ends
 * with one, so `matt` leaves `frontmatter` alone.
 */
function applyRules(text: string, rules: RenameRule[]): string {
  return rules.reduce((current, [from, to]) => {
    const before = isWordChar(from.at(0)) ? "(?<![\\p{L}\\p{N}_])" : "";
    const after = isWordChar(from.at(-1)) ? "(?![\\p{L}\\p{N}_])" : "";
    const pattern = new RegExp(`${before}${escapeRegExp(from)}${after}`, "gu");
    return current.replace(pattern, () => to);
  }, text);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}
