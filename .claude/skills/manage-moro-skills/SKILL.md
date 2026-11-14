---
name: manage-moro-skills
description: Drive `moro add` and `moro sync` while developing the set. Use when bringing in a skill from another repo, taking upstream changes, or resolving sync conflicts.
---

# Manage moro skills

Run from the set's clone. Drive `moro` through its no-prompt modes (`--yes`, `status`, `show`, `accept`, `skip`) and put each decision to the owner as a selection: recommended option first, a typed answer allowed. The owner never meets a CLI prompt.

## Closing lines

Repeat the CLI's closing lines (`Added …`, `Accepted: …`, `Not pushed: …`, `Pushed.`, `Next: …`, `Up to date.`) word for word, last in your reply.

## Add a skill

1. Ask which skills of `<ref>` to take. Offer `--all` first when the owner named none, then a typed list.
2. Per skill, ask its group (the source's folder first, then the set's groups), recommended (no first) and dependencies (skills its text names first).
3. Run `moro add <ref> <skill…> --group <name> [--recommended] [--depends-on <key…>] --yes`. The flags apply to every skill of one run, so skills with different answers get separate runs. On a clash the run changes nothing: ask keep the set's copy or replace it, then rerun with `--on-clash keep` or `--on-clash replace`.
4. Name every skill the incoming skill's text depends on that the set lacks, and offer to add each.

Done when `moro` printed `Added …` and every named dependency is in the set or declined.

## Sync

1. Run `moro sync status`. It only reads; `accept`, `skip` and bare `moro sync` also follow upstream moves and re-render changed rename rules, each in its own commit.
2. For each listed skill, run `moro sync show <skill>` and sum up the diff in a few lines: what changed, whether it touches a hand edit, whether it brings Matt names the rename rules miss.
3. Ask accept, skip or later. Put accept first when the change merges cleanly without touching a hand edit (no conflict, no hand-edited file changed upstream, not removed upstream); otherwise put later or skip first and say why. Name any uncovered Matt lines either way.
4. Run `moro sync accept <skill>` or `moro sync skip <skill>`. Later runs nothing.

Done when every listed skill is accepted, skipped or left for later.

## Conflicts

A conflicting accept leaves diff3 markers in the skill's folder, moves the pin and commits nothing. Read the markers, propose a resolution per hunk that keeps the owner's hand edit and the upstream change, and ask the owner to confirm (accept the proposal first, typed alternative allowed). Write it, then run `moro sync accept <skill>`. It commits once no `<<<<<<<` or `>>>>>>>` lines remain. Other skills can be accepted or skipped meanwhile; each conflict waits on its own markers only.

## Push

Single-skill commands end with `Not pushed`. Ask whether to run `git push` in the clone (yes first).

## Next step

End with the CLI's `Next: …` line. After a push, that is running `/setup-moro-skills` in each project that should get the change.
