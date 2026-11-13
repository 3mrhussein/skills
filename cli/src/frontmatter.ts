// A SKILL.md's frontmatter: the block between the leading `---` lines.
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---/;
const NAME_LINE = /^name:[ \t]*(.*?)[ \t]*$/m;

export function frontmatterName(text: string): string | undefined {
  const name = NAME_LINE.exec(FRONTMATTER.exec(text)?.[0] ?? "")?.[1];
  return name ? name.replace(/^(["'])(.*)\1$/, "$2") : undefined;
}

/** Sets the frontmatter `name`, leaving everything else as it was. */
export function setFrontmatterName(text: string, name: string): string {
  return text.replace(FRONTMATTER, (frontmatter) =>
    frontmatter.replace(/^name:[ \t]*.*$/m, () => `name: ${name}`),
  );
}
