<!-- Hand edit for setup-moro-skills, for ticket 18: paste the section below into the skill's SKILL.md as its first step, before Matt's repo setup. The rest of the skill stays upstream's text. -->

## Step 1: Install skills into this project

Put every question to the owner as a selection, recommended option first, a typed answer allowed. Pass the answers to `moro install` as flags, so no CLI prompt opens.

1. Run `moro` in the project. Relay the lines under `This project against the set:`, if any. If `moro` isn't found, tell the owner to run `./install.sh` in the set's clone, then stop.
2. Ask which skills the project should have. List the skills in `<clone>/skills/<group>/` and `<clone>/local-only/<group>/` under their groups, all but `setup-moro-skills`, which stays at user level; the clone is the `clone` in `~/.config/moro/config.json`. Tick the manifest's `recommended` ones on a first install, and the skills in the project's `skills-lock.json` on a rerun. `moro` adds required skills and dependencies itself.
3. For each pick the report labels `edited here` or `loose`, show `diff -ru <project copy> <clone copy>` and ask whether the set's copy replaces it (no first).
4. On a first install, ask whether to keep the skills out of git or commit them (keep out first).
5. Run `moro install --pick <skills…> [--keep-out | --commit] [--use-set-copy <skills…>]` and relay its closing lines word for word, including any `Shadowed at user level:` warning and its `Next:` line.

Done when the summary printed `Up to date.` or its `Installed`, `Updated` and `Removed` lines.

Then go on to repo setup below.
