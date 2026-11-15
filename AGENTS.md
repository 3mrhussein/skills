# Writing rules

- Load `writing-for-agents` before writing or editing a skill, this file, `CLAUDE.md` or the README.
- End every own skill by naming the next step.
- Make every prompt in a skill a selection: recommended option first, an optional typed answer.
- Write commit messages with no attribution: no `Co-Authored-By`, no tool or vendor names.

## Agent skills

### Issue tracker

Issues and specs live as local markdown under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default roles, recorded as `Status:` lines: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
