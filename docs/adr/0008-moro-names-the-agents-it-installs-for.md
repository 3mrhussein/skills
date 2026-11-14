# moro names the agents it installs for

Every `skills add` and `skills remove` that moro runs passes `-a` with the agents the owner picked: Claude Code, Codex, GitHub Copilot and Antigravity by default. Before this, moro passed no `-a` and let the `skills` CLI choose. Run inside Claude Code, that CLI read the agent id `claude-code_2-1-325_agent`, failed to match it to an agent, and installed into `.agents/skills` alone. The project's Claude sessions saw none of its skills, and moro still printed `Installed`. This replaces the spec's "Installs pass no `-a`" and removes "install routes for other agents" from its out-of-scope list.

## Considered options

- Let the `skills` CLI pick, the earlier plan: no question to ask, but what it picks depends on how it detects the caller, and that detection already failed once.
- Claude Code only: the agent the owner uses most, but Codex, Copilot and Antigravity read the same project `.agents/skills`, so including them costs one flag.

## Consequences

- The project install asks two more questions, the same way it asks keep-out or commit: which agents (the four ticked) and which install method (symlink first, or copy). `/setup-moro-skills` asks them as selections and passes `--agents` and `--symlink` or `--copy`. `moro install` run by hand asks the agents on a first install (the four ticked, `gemini-cli` offered); a rerun keeps the agents on disk unless `--agents` names others.
- On a rerun the answers are read from disk: the agents are the folders that hold the installed skills, and the method is whether those folders hold links. No new record is kept.
- Leaving out an agent with its own folder (Claude Code) removes the skills from that folder. The shared `.agents/skills` stays while the skills are installed, so leaving out Codex, Copilot or Antigravity alone changes nothing on disk. Switching method reinstalls every skill with the new method.
- Bootstrap installs the entry skill at user level for the same agents, with `--agents` to change them.
- After installing, moro checks that each picked skill is in each picked agent's folder. It warns about anything missing, naming the skill, the agent and the `skills` CLI's own warning, but doesn't fail.
- When an agent other than Claude Code is picked, the repo setup's `## Agent skills` block lives in `AGENTS.md`. If Claude Code is picked too, `CLAUDE.md` holds `@AGENTS.md` in place of the block. A block already in `CLAUDE.md` moves to `AGENTS.md`.
- `moro install --user` names the same agents at user level. The `skills` CLI puts Codex, Copilot and Antigravity there in the shared `~/.agents/skills`, and links Claude Code's `~/.claude/skills` to it (ADR 0005, amended).
