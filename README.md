# Moro Skills

My set of agent skills, kept in one repo. Each device clones it and installs from that clone, one project at a time. Vocabulary is in [GLOSSARY.md](GLOSSARY.md), decisions in [docs/adr/](docs/adr/).

## Set up a device

You need node 22.20 or newer, and git.

1. Clone this repo anywhere.
2. Run `./install.sh` in the clone.

`./install.sh` builds the `moro` CLI in `cli/`, links it with `npm link`, and hands over to `moro bootstrap`. Bootstrap changes four things on the device:

- **The device file.** `~/.config/moro/config.json` records where the clone is (`$XDG_CONFIG_HOME/moro/` when that is set). Every other `moro` command reads it.
- **Shadowing skills.** A user-level skill in `~/.agents/skills` or `~/.claude/skills` shadows when it shares a name with a set skill, or was installed from the same upstream skill under any name. Bootstrap shows them in one numbered table that is also the picker, each labelled against the set's copy with a recommendation. `same as the set's` and `from <source>, like the set's` (unedited since install) start ticked; `differs from the set's` starts unticked, since it may hold your edits. Every other user-level skill stays, named in `Left at user level:`, and so does `~/.claude/skills/synced`.
- **A snapshot.** Before the first removal, bootstrap saves those folders and the user-level lock to `~/.config/moro/backups/<date>.tar.gz` and prints how to restore them: `tar -xzf <snapshot> -C /`.
- **`/setup-moro-skills`, the entry skill.** It is installed at user level from the clone, and every rerun brings it up to date. It is the default way to set up a project, so it is ready in any project; project installs leave it out.

A first run ends like this:

```
Recorded the clone.
Removed: <the shadowing skills you picked>.
Installed: setup-moro-skills.

Next: open a project and run `/setup-moro-skills`
```

`./install.sh --yes` takes every default without asking: it removes the ticked shadowing skills and keeps the rest.

Nothing remembers a skill you kept, so every rerun asks about each shadowing skill still there, including one a pull brought into the set.

`install.sh` finds `moro` for its own run. If a new shell says `moro: command not found`, put npm's global bin on your PATH: `export PATH="$(npm prefix -g)/bin:$PATH"`.

### After a pull

Rerun `./install.sh`. It rebuilds and relinks `moro`, reinstalls `/setup-moro-skills` if it changed, offers to retire any skill the pull made shadowing, and otherwise says `Up to date.` Until you rerun it, `moro` in the clone prints:

```
Next: rerun ./install.sh, because the moro build is older than the clone's cli/.
```

Next: open a project and run `/setup-moro-skills`.

## Set up a project

Open the project in your agent and run `/setup-moro-skills`. It runs `moro install`, which shows how the project differs from the clone and lets you pick skills, then it prepares the repo. On a first install you choose to commit the skills or keep them out of git.

Rerun `/setup-moro-skills` (or `moro install`) to catch the project up with the clone, or to change the picks. When a user-level skill shadows a pick, `moro install` names it and ends with `Next: rerun ./install.sh in the set's clone.`

## Local-only skills

A skill that must stay on one device goes in `local-only/<group>/<name>`. Git ignores that folder. Every project install offers these skills ticked and keeps them out of the project's git.

A project that commits its skills also commits `skills-lock.json`, which names its local-only skills and the path to the clone. Keep such a project's skills out of git when those names must stay private ([ADR 0006](docs/adr/0006-local-only-skills-live-in-a-gitignored-folder.md)).

## The `moro` CLI

Bare `moro` prints where you stand and the one next step. Outside a project it reports the clone:

```
Clone: /path/to/clone (main)
Unpushed: none
Last sync: never

Up to date.
```

Inside a project (a git repo with `skills-lock.json` at its top) it compares the project with the set:

```
This project against the set:
  not installed: <skills>

Up to date.
```

Every command ends with a `Next:` line or `Up to date.` Each prompt is a selection with the recommended option first. The flags below answer a prompt up front, so a command can run without asking anything. Add and sync end by offering to push the clone's current branch; a branch with no upstream yet, such as a trial's, is pushed to `origin` and tracks it from then on.

| Command | Where | What it does | Flags |
| --- | --- | --- | --- |
| `moro install` | a project | Picks skills from the clone and installs them | `--yes` takes every recommended answer. `--pick <skill…>` replaces the picker. `--keep-out` or `--commit` answers the first install's git question. `--use-set-copy <skill…>` replaces edited or loose copies with the set's. `--from <worktree>` installs from a trial's worktree; a later run without it brings the project back to `main`. |
| `moro add <ref> [skill…]` | the clone or a trial's worktree | Brings skills from another repo into the set | `--all`, `--group <name>`, `--recommended`, `--depends-on <key…>`, `--on-clash keep\|replace`, `--yes` |
| `moro sync` | the clone or a trial's worktree | Walks upstream changes and accepts, skips or falls back on each skill | `--yes` accepts the changes that merge cleanly without touching a hand edit, and leaves the rest for later. Fallback drops a skill's hand edits and takes the upstream text as it is; it's offered only for a skill with hand edits. `moro sync status` only reads. `show <skill>`, `accept <skill>`, `skip <skill>` and `fallback <skill>` handle one skill. `show` names the skills that call it, and an accept or fallback warns with the workflow check's findings. |
| `moro try <skill>` | anywhere | A trial of an upstream change: the fallback and the adapted copy of a skill with hand edits (one candidate without), each on a `try/` branch in a worktree beside the clone (`<clone>-try/`). Prints each candidate's diff against `main`, workflow check, impact and `moro install --from` line; `main` stays as it is. Rerun to see an open trial. | `--json` for `manage-moro-skills`. `--keep fallback\|adapted` merges that candidate into `main`, removes the trial and offers to push (`--yes` pushes). `--drop` removes the trial. |
| `moro check [folder]` | anywhere | The workflow check: every skill another skill calls is in the folder (the clone by default), can be called, and is listed in the caller's `dependsOn` | `--impact <skill>` lists the skills that call it, directly or through another. `--json` for `manage-moro-skills`. Exits 1 on any finding. |
| `moro bootstrap` | the clone | The last step of `./install.sh` | `--yes` |
| `moro --version` | anywhere | Prints the CLI's version | |

## Help

- `/ask-moro` routes any job to the right skill.
- `moro` prints where the clone or the project stands, and the next step.
- To add, sync or try skills from other repos, open your agent in this clone and ask: `manage-moro-skills` drives `moro add`, `moro sync` and `moro try`.
