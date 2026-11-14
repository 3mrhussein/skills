---
Status: superseded by ADR-0006
---

# Work skills live in a top-level `work/` folder, outside `skills/`

Work skills must install only on machines where the owner opts in. The `skills` CLI discovers everything under `skills/` (up to three levels deep) by default, and `-y`, `--all` and any `add` run inside a coding agent install everything it discovers, so `skills/work/` would put company skills on a personal laptop by mistake. A top-level `work/` isn't scanned: work installs only when asked for, by subpath (`3mrhussein/skills/work`) or by name, and `update` still reaches installed work skills because it searches the full depth. Don't move `work/` under `skills/` to tidy the layout.

## Considered options

- `skills/work/` with an explicit `--skill` list on every install: one forgotten flag installs work.
- `metadata.internal: true` on each work skill: `update` doesn't see internal skills, treats them as deleted upstream and offers to remove them, unless every run sets `INSTALL_INTERNAL_SKILLS=1`.

## Consequences

`npx skills add 3mrhussein/skills --full-depth` does show work skills. Skill names must be unique across `skills/` and `work/`, because a work machine installs both into one folder.
