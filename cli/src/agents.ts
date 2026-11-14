// The agents an install names to the `skills` CLI with `-a`, so what lands never
// depends on how that CLI detects its caller (ADR 0008).
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Ticked by default: Claude Code, and three agents that read the shared `.agents/skills`. */
export const DEFAULT_AGENTS = ["claude-code", "codex", "github-copilot", "antigravity"];

/** Offered by the agents question: the defaults, then other agents that read the shared folder. */
export const OFFERED_AGENTS = [...DEFAULT_AGENTS, "gemini-cli"];

/** Where an agent other than the shared-folder ones keeps its skills, relative to a project or the home folder. */
const OWN_FOLDER: Record<string, { project: string; user: string }> = {
  "claude-code": { project: ".claude/skills", user: ".claude/skills" },
};

/** Whether the agent keeps its skills in a folder of its own rather than the shared one. */
export function hasOwnFolder(agent: string): boolean {
  return agent in OWN_FOLDER;
}

/** The folder holding the canonical copy every agent's folder links to, in a project and at user level alike. */
export const SHARED_FOLDER = ".agents/skills";

/** The folder this agent reads a skill from, under `root` (a project's top level, or the home folder). */
export function agentFolder(root: string, agent: string, name: string, scope: "project" | "user"): string {
  const own = OWN_FOLDER[agent];
  return join(root, own ? own[scope] : SHARED_FOLDER, name);
}

/**
 * The agents a rerun keeps when none are named: the defaults that read the shared folder, plus each
 * agent with its own folder that holds one of the installed skills.
 */
export function agentsOnDisk(root: string, installed: string[], scope: "project" | "user"): string[] {
  return DEFAULT_AGENTS.filter((agent) => !OWN_FOLDER[agent] || installed.some((name) => existsSync(agentFolder(root, agent, name, scope))));
}

/** The skills from `names` missing from at least one agent's folder, each with those agents. */
export function missingFrom(root: string, agents: string[], names: string[], scope: "project" | "user"): Map<string, string[]> {
  const missing = new Map<string, string[]>();
  for (const name of names) {
    const without = agents.filter((agent) => !existsSync(join(agentFolder(root, agent, name, scope), "SKILL.md")));
    if (without.length > 0) missing.set(name, without);
  }
  return missing;
}
