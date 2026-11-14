# Moro Skills

My set of agent skills, kept in one repo. Each device clones it and installs from that clone, one project at a time. Vocabulary is in [GLOSSARY.md](GLOSSARY.md), decisions in [docs/adr/](docs/adr/).

## Set up a device

You need node 22.20 or newer, and git.

1. Clone this repo anywhere.
2. Run `./install.sh` in the clone.

`./install.sh` builds the `moro` CLI in `cli/`, links it with `npm link`, and hands over to `moro bootstrap`. Bootstrap changes four things on the device:

- **The device file.** `~/.config/moro/config.json` records where the clone is (`$XDG_CONFIG_HOME/moro/` when that is set). Every other `moro` command reads it.
- **Other user-level skills.** Bootstrap lists every skill in `~/.agents/skills` and `~/.claude/skills`, then asks once whether to remove them, so none shadows a project's copy. Yes is the default. The Claude app's own skills in `~/.claude/skills/synced` stay.
- **A snapshot.** Before removing anything, bootstrap saves those folders and the user-level lock to `~/.config/moro/backups/<date>.tar.gz` and prints how to restore them: `tar -xzf <snapshot> -C /`.
- **`/setup-moro-skills`.** It is installed at user level from the clone, and is the only skill left there.

A first run ends like this:

```
Recorded the clone.
Removed: <your other user-level skills>.
Installed: setup-moro-skills.

Next: open a project and run `/setup-moro-skills`
```

`./install.sh --yes` takes every default without asking.

`install.sh` finds `moro` for its own run. If a new shell says `moro: command not found`, put npm's global bin on your PATH: `export PATH="$(npm prefix -g)/bin:$PATH"`.

### After a pull

Rerun `./install.sh`. It rebuilds and relinks `moro`, reinstalls `/setup-moro-skills` if it changed, and otherwise says `Up to date.` Until you rerun it, `moro` in the clone prints:

```
Next: rerun ./install.sh, because the moro build is older than the clone's cli/.
```

Next: open a project and run `/setup-moro-skills`.

## Set up a project

Open the project in your agent and run `/setup-moro-skills`. It runs `moro install`, which shows how the project differs from the clone and lets you pick skills, then it prepares the repo. On a first install you choose to commit the skills or keep them out of git.

Rerun `/setup-moro-skills` to catch the project up with the clone, or to change the picks.

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

Every command ends with a `Next:` line or `Up to date.` Each prompt is a selection with the recommended option first. The flags below answer a prompt up front, so a command can run without asking anything.

| Command | Where | What it does | Flags |
| --- | --- | --- | --- |
| `moro install` | a project | Picks skills from the clone and installs them | `--yes` takes every recommended answer. `--pick <skill…>` replaces the picker. `--keep-out` or `--commit` answers the first install's git question. `--use-set-copy <skill…>` replaces edited or loose copies with the set's. |
| `moro add <ref> [skill…]` | the clone | Brings skills from another repo into the set | `--all`, `--group <name>`, `--recommended`, `--depends-on <key…>`, `--on-clash keep\|replace`, `--yes` |
| `moro sync` | the clone | Walks upstream changes and accepts or skips each skill | `--yes` accepts the changes that merge cleanly without touching a hand edit, and leaves the rest for later. `moro sync status` only reads. `show <skill>`, `accept <skill>` and `skip <skill>` handle one skill. |
| `moro bootstrap` | the clone | The last step of `./install.sh` | `--yes` |
| `moro --version` | anywhere | Prints the CLI's version | |

## Help

- `/ask-moro` routes any job to the right skill.
- `moro` prints where the clone or the project stands, and the next step.
- To add or sync skills from other repos, open your agent in this clone and ask: `manage-moro-skills` drives `moro add` and `moro sync`.
