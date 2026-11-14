# Moro Skills

My set of agent skills, kept in one repo. Each device clones it and installs from that clone, one project at a time. Vocabulary is in [GLOSSARY.md](GLOSSARY.md), decisions in [docs/adr/](docs/adr/).

## Set up a device

1. Clone this repo anywhere.
2. Run `./install.sh` in the clone. It builds the `moro` CLI, records where the clone is, puts `/setup-moro-skills` at user level and offers to retire every other user-level skill. Rerun it after a pull.

## Set up a project

Open the project in your agent and run `/setup-moro-skills`. It shows how the project differs from the clone, lets you pick skills, then prepares the repo.

## Local-only skills

A skill that must stay on one device goes in `local-only/<group>/<name>`. Git ignores that folder. Every project install offers these skills ticked and keeps them out of the project's git.

## Help

- `/ask-moro` routes any job to the right skill.
- `moro` prints where the clone or the project stands, and the next step.
- To add or sync skills from other repos, open your agent in this clone and ask: `manage-moro-skills` drives `moro add` and `moro sync`.
