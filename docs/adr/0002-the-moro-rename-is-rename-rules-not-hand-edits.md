# The moro rename is recorded as rename rules, not as hand edits

Upstream skills from Matt Pocock's set are renamed to say moro. The rename is stored in the manifest as an ordered list of literal, whole-word rename rules per source, and sync applies them to the source's text before the owner sees it. A hand edit is then exactly the difference between the set's copy and the source's text at the pin with the rules applied, which gives sync a clean base for a three-way merge. Recording the rename as ordinary hand edits was rejected: every upstream change near a Matt mention would conflict at every sync.

## Consequences

- Rules are whole-word: Matt's text has "matt" inside `frontmatter`, `matters` and `formatting`.
- A skill's folder name and frontmatter `name` always equal its manifest key, so renaming a skill (for the moro rename or a name clash) is choosing its key. A rule on its source makes that source's other skills use the new name.
- Only Matt's source has rules for now. Other sources keep their own names.
- Rules also rename file names inside a skill's folder, and they can hold back a source's convention, not only names: Matt's `GLOSSARY.md` and `GLOSSARY-MAP.md` become `CONTEXT.md` and `CONTEXT-MAP.md` (decided with sync, 2026-11-10).
- Changing a source's rules makes sync re-render that source's skills: a three-way merge from the old rules' text to the new rules' text, at the same pin. Otherwise every copy would look hand-edited.
