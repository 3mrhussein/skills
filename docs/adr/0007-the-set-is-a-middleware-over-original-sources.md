# The set sits between original sources and projects; changes are tried in worktrees of the clone

The manifest's sources stay the original repos (`mattpocock/skills`, not a fork), and the set takes whole sources. Each upstream skill reaches projects either as the source's text or with the owner's hand edits. When a source changes a skill the owner has edited, the owner can try both candidates side by side before one reaches `main`: the **fallback** (drop the hand edits and take the change as it is) and the **adapted** copy (the hand edits merged with the change). Each candidate lives on a branch of the clone, in its own worktree, and trial projects install from it. A prototype ran the owner's loop through the real CLI for originals, forks and submodules (`.scratch/personal-skill-set/assets/22-sources-prototype/`). Trying a change, the workflow check and the mapping worked the same way in all three, so only tracking and editing set them apart. Originals came out simplest on both.

## Considered options

- **Forks on `3mrhussein` as sources.** These need no CLI change, but an upstream change stays hidden until someone presses "Sync fork" on GitHub, and a fork of a public repo can't be private. Editing in the fork breaks ADR 0003 and ADR 0004: one fork merge decides every skill at once, conflicts block GitHub's button, the owner's own edits show up as upstream commits, and pins become merge commits that exist only in the fork.
- **Submodules under `references/`.** `moro add` refuses a relative path. An absolute path commits one device's folder, and another device then can't reach the source. These need CLI changes plus `--recursive` or `submodule update --init` on every device, and an upstream change takes a fork sync, a pull and a bump commit before it shows.
- **A `lab` group.** A lab copy needs a different name, so the skills that call it keep calling the original and the workflow isn't really tried.

## Consequences

- Sync gains a third answer, fallback, next to accept and skip. The dropped hand edits stay in git history.
- The workflow check reads Skill-tool calls, following Matt's convention ("Call the Skill tool with …"). It runs on any folder of skills. Matt's text at `5863806` gives exactly the `dependsOn` the owner chose for ticket 18. Its **impact** report lists every skill that calls the changed one, directly or through another skill.
- `moro audit` compares only the current project, because nothing records projects (ADR 0005).
- Commands that commit can run on a branch of the clone; a push sets the branch's upstream.
