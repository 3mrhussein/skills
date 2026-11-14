---
name: manage-moro-skills
description: Drive `moro add`, `moro sync` and `moro try` while developing the set. Use when bringing in a skill from another repo, taking upstream changes, trying a change's candidates side by side, or resolving sync conflicts.
---

# Manage moro skills

Run from the set's clone. Drive `moro` through its no-prompt modes (`--yes`, `status`, `show`, `accept`, `skip`, `fallback`, `check --json`, `try --json`, `try --keep`, `try --drop`) and put each decision to the owner as a selection: recommended option first, a typed answer allowed. The owner never meets a CLI prompt.

## Closing lines

Repeat the CLI's closing lines (`Added …`, `Accepted …`, `Skipped …`, `Fell back …`, `Not pushed: …`, `Pushed.`, `Kept …`, `Dropped …`, `Pushed main…`, `Next: …`, `Up to date.`) word for word, last in your reply.

## Add a skill

1. Ask which skills of `<ref>` to take. Offer `--all` first when the owner named none, then a typed list.
2. Per skill, ask its group (the source's folder first, then the set's groups), recommended (no first) and dependencies (skills its text names first).
3. Run `moro add <ref> <skill…> --group <name> [--recommended] [--depends-on <key…>] --yes`. The flags apply to every skill of one run, so skills with different answers get separate runs. On a clash the run changes nothing: ask keep the set's copy or replace it, then rerun with `--on-clash keep` or `--on-clash replace`.
4. Name every skill the incoming skill's text depends on that the set lacks, and offer to add each.

Done when `moro` printed `Added …` and every named dependency is in the set or declined.

## Sync

1. Run `moro sync status`. It only reads; `accept`, `skip` and bare `moro sync` also follow upstream moves and re-render changed rename rules, each in its own commit.
2. For each listed skill, run `moro sync show <skill>` and sum up the diff in a few lines: what changed, whether it touches a hand edit, whether it brings Matt names the rename rules miss, and its `Impact:` line (the skills that call it, which the change reaches too).
3. Ask accept, skip or later. Put accept first when the change merges cleanly without touching a hand edit (no conflict, no hand-edited file changed upstream, not removed upstream); otherwise put later or skip first and say why. For a skill with hand edits, also offer fallback, after accept and skip: it drops the hand edits on `show`'s `Hand edits:` line and takes the upstream text as it is. Offer a trial too (see Trial) when the owner wants to use both before choosing. Name any uncovered Matt lines either way.
4. Run `moro sync accept <skill>`, `moro sync skip <skill>` or `moro sync fallback <skill>`. Later runs nothing.
5. After each accept or fallback, run `moro check --json` and explain each finding in one line: which skill calls which, and why it doesn't fit. Offer its fix as a selection, the fix first and "leave it" second:
   - `missing`: add the called skill with `moro add`, or reword the call.
   - `user-invoked`: reword the call as an instruction for the owner to run `/<skill>`.
   - `undeclared` or `stale`: add the call to, or drop it from, the caller's `dependsOn` in `manifest.json`.
   - `required` or `router`: restore the required skill, or name the recommended skill in `ask-moro`.

Done when every listed skill is accepted, skipped, fallen back or left for later, and every check finding is fixed or left by the owner.

## Conflicts

A conflicting accept leaves diff3 markers in the skill's folder, moves the pin and commits nothing. Read the markers, propose a resolution per hunk that keeps the owner's hand edit and the upstream change, and ask the owner to confirm (accept the proposal first, typed alternative allowed). Write it, then run `moro sync accept <skill>`. It commits once no `<<<<<<<` or `>>>>>>>` lines remain. When the owner would rather drop their hand edits, `moro sync fallback <skill>` replaces the markers with the upstream text and commits. Other skills can be accepted or skipped meanwhile; each conflict waits on its own markers only.

## Trial

A trial puts a skill's candidates on `try/` branches, each in a worktree beside the clone, and leaves `main` as it is. `git worktree` writes to the clone's `.git/worktrees`, so in a sandbox run `moro try` outside it.

1. Run `moro try <skill> --json`. It makes the candidates, or shows the trial already open: `fallback` and `adapted`, or `accept` alone for a skill without hand edits. Each has its `worktree`, `diff` against `main`, `conflicts`, workflow check `findings` and `impact`.
2. For each candidate with `conflicts`, resolve the markers as under Conflicts, in its worktree, then run `moro sync accept <skill>` there and rerun step 1. To add a newly called skill or fix `dependsOn` for one candidate, run `moro add` or edit `manifest.json` in its worktree; commits there stay on its branch.
3. Compare the candidates: what each diff keeps and drops, and each one's findings, explained as under Sync.
4. Read the text of every skill in each candidate's `impact`, in that worktree, for steps that rely on the lines the diff changes: a dropped section, a renamed step, a changed output or name. Done when every impacted skill is read and each reliance is named with the candidate that breaks it.
5. Recommend one candidate with its reasons, and ask: keep the recommended one first, then each other candidate, drop the trial, and try them first (the trial stays open). On keep run `moro try <skill> --keep <candidate> --yes`, which merges it into `main`, removes the trial and pushes; on drop run `moro try <skill> --drop`.
6. On try them first, give each candidate's `install` line to run in a trial project, and end with `Next: run moro try <skill> --keep <recommended>` once the trial projects agree.

## Push

Single-skill commands on `main` end with `Not pushed`. Ask whether to push (yes first), then run `git push` in the clone. In a trial's worktree they end with `Next: run moro try <skill>` instead: `--keep` pushes `main`.

## Next step

End with the CLI's `Next: …` line. After a push, that is running `/setup-moro-skills` in each project that should get the change.
