// `moro check [folder]`: the workflow check (ADR 0007). Reads the skills under a folder
// (the clone, a trial's worktree, a project or a whole source) and the manifest there,
// if any, and reports where the skills that call each other don't fit.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { findSet } from "./device.js";
import { frontmatterName } from "./frontmatter.js";
import type { MoroIo } from "./main.js";
import { MANIFEST_FILE, type Manifest } from "./manifest.js";
import { LOCAL_ONLY_DIR, SKILLS_DIR } from "./set-layout.js";
import { UserError } from "./user-error.js";

const USAGE = "moro check [folder] [--impact <skill>] [--json]";

/** The skill that routes the owner to the set's skills by name. */
const ROUTER = "ask-moro";

export interface CheckedSkill {
  name: string;
  /** The skill's folder, relative to the checked folder. */
  path: string;
  text: string;
}

export type FindingKind = "missing" | "user-invoked" | "undeclared" | "stale" | "required" | "router";

export interface Finding {
  kind: FindingKind;
  /** The skill the finding is about: the caller, the router, or the required path. */
  skill: string;
  /** The skill it names. */
  target: string;
  /** The finding as one line. */
  message: string;
}

export interface WorkflowCheck {
  folder: string;
  /** Whether the folder holds a manifest, which makes it a set (the clone or a trial's worktree). */
  isSet: boolean;
  skills: CheckedSkill[];
  /** Each skill's Skill-tool calls, in the order its text makes them. */
  calls: Record<string, string[]>;
  findings: Finding[];
}

export interface Reach {
  skill: string;
  /** 1 for a direct caller, more through other callers. */
  depth: number;
  /** The caller, down to the changed skill. */
  via: string[];
}

const FINDING_ORDER: FindingKind[] = ["missing", "user-invoked", "undeclared", "stale", "required", "router"];

export async function check(io: MoroIo, argv: string[]): Promise<number> {
  const { folder: given, impact: changed, json } = parseArgs(argv);
  const folder = given === undefined ? findSet(io) : resolve(io.cwd, given);
  if (!existsSync(folder) || !statSync(folder).isDirectory()) {
    throw new UserError(`${folder} isn't a folder.\n\nNext: run ${USAGE} with a folder of skills, or no folder for the clone.`);
  }
  const result = workflowCheck(folder);
  const impact = changed === undefined ? null : impactIn(result, changed);

  if (json) {
    const { skills, calls, findings } = result;
    io.stdout.write(`${JSON.stringify({ folder, skills: skills.map((skill) => skill.name), calls, findings, impact }, null, 2)}\n`);
    return result.findings.length > 0 ? 1 : 0;
  }

  const out = [`Workflow check of ${result.isSet ? "the set at " : ""}${folder}: ${result.skills.length} skill${result.skills.length === 1 ? "" : "s"}.`];
  const calling = Object.entries(result.calls).filter(([, callees]) => callees.length > 0);
  if (calling.length > 0) out.push("Calls:", ...calling.map(([caller, callees]) => `  ${caller} -> ${callees.join(", ")}`));
  out.push(...(result.findings.length > 0 ? ["Findings:", ...findingLines(result.findings)] : ["Findings: none."]));
  if (impact && changed) out.push("", ...impactLines(changed, impact));
  out.push(
    "",
    result.findings.length > 0
      ? `Next: fix each finding in the skill's text${result.isSet ? " or in manifest.json" : ""}, then rerun \`moro check\`.`
      : "Next: run `moro sync status` to check upstream skills.",
  );
  io.stdout.write(`${out.join("\n")}\n`);
  return result.findings.length > 0 ? 1 : 0;
}

function parseArgs(argv: string[]): { folder?: string; impact?: string; json: boolean } {
  const parsed: { folder?: string; impact?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--json") parsed.json = true;
    else if (arg === "--impact") {
      const skill = argv[++i];
      if (!skill || skill.startsWith("-")) throw usage("--impact takes one skill");
      parsed.impact = skill;
    } else if (arg.startsWith("-")) throw usage(`Unknown option: ${arg}`);
    else if (parsed.folder !== undefined) throw usage("check takes one folder");
    else parsed.folder = arg;
  }
  return parsed;
}

function usage(problem: string): UserError {
  return new UserError(`${problem}.\n\nNext: run ${USAGE}`);
}

/** The check of the skills under `folder`, with the manifest there when it holds one. */
export function workflowCheck(folder: string): WorkflowCheck {
  const manifestFile = join(folder, MANIFEST_FILE);
  const manifest = existsSync(manifestFile) ? (JSON.parse(readFileSync(manifestFile, "utf8")) as Partial<Manifest>) : undefined;
  const skills = readSkills(folder, manifest !== undefined);
  return { folder, isSet: manifest !== undefined, skills, ...checkWorkflow(skills, manifest) };
}

/**
 * The pure check. A call is a Skill-tool instruction in Matt's convention: in a sentence that
 * says `call(s) the Skill tool`, each name in double quotes or backticks.
 */
export function checkWorkflow(skills: CheckedSkill[], manifest: Partial<Manifest> | undefined): Pick<WorkflowCheck, "calls" | "findings"> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const where = manifest ? "the set" : "this folder";
  const findings: Finding[] = [];
  const add = (kind: FindingKind, skill: string, target: string, message: string) => findings.push({ kind, skill, target, message });
  const calls: Record<string, string[]> = {};

  for (const skill of skills) {
    const called = new Set<string>();
    for (const sentence of skill.text.match(/\bcall(?:s|ing)? the Skill tool[^.\n]*/gi) ?? []) {
      for (const [, name] of sentence.matchAll(/["`]([a-z0-9-]+)["`]/g)) if (name !== skill.name) called.add(name!);
    }
    calls[skill.name] = [...called];
    for (const callee of called) {
      const target = byName.get(callee);
      if (!target) add("missing", skill.name, callee, `${skill.name} calls "${callee}", which isn't in ${where}.`);
      else if (userInvoked(target.text)) {
        add("user-invoked", skill.name, callee, `${skill.name} calls "${callee}", which is user-invoked (disable-model-invocation: true), so no skill can call it.`);
      }
      if (manifest && !(manifest.dependsOn?.[skill.name] ?? []).includes(callee)) {
        add("undeclared", skill.name, callee, `${skill.name} calls "${callee}", but dependsOn.${skill.name} doesn't list it.`);
      }
    }
  }

  for (const [name, needs] of Object.entries(manifest?.dependsOn ?? {})) {
    if (!byName.has(name)) continue;
    for (const need of needs) {
      if (!calls[name]!.includes(need)) add("stale", name, need, `dependsOn.${name} lists "${need}", but ${name} never calls it.`);
    }
  }

  const paths = new Set(skills.map((skill) => skill.path));
  for (const path of manifest?.required ?? []) {
    if (!path.endsWith("/*") && !paths.has(path)) add("required", path, path, `required ${path} isn't in ${where}.`);
  }

  const router = byName.get(ROUTER);
  if (router) {
    const named = new Set([...router.text.matchAll(/(?:^|[\s`"'(])\/([a-z0-9-]+)/g)].map(([, name]) => name!));
    const byPath = new Map(skills.map((skill) => [skill.path, skill.name]));
    for (const path of manifest?.recommended ?? []) {
      const name = byPath.get(path);
      if (name && name !== ROUTER && !named.has(name)) add("router", ROUTER, name, `${ROUTER} never names /${name}, a recommended skill.`);
    }
  }

  findings.sort((a, b) => FINDING_ORDER.indexOf(a.kind) - FINDING_ORDER.indexOf(b.kind));
  return { calls, findings };
}

function userInvoked(text: string): boolean {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  return /^disable-model-invocation:[ \t]*true[ \t]*$/m.test(frontmatter);
}

/**
 * The skills a change to `changed` reaches through the skills that call it:
 * its direct callers, then their callers, each with the path down to `changed`.
 */
export function impactOf(calls: Record<string, string[]>, changed: string): Reach[] {
  const callers = new Map<string, string[]>();
  for (const [caller, callees] of Object.entries(calls)) {
    for (const callee of callees) callers.set(callee, [...(callers.get(callee) ?? []), caller]);
  }
  const reached = new Map<string, string[]>([[changed, [changed]]]);
  let level = [changed];
  const out: Reach[] = [];
  while (level.length > 0) {
    const next: string[] = [];
    for (const at of level) {
      for (const caller of (callers.get(at) ?? []).toSorted()) {
        if (reached.has(caller)) continue;
        const via = [caller, ...reached.get(at)!];
        reached.set(caller, via);
        next.push(caller);
      }
    }
    out.push(...next.toSorted().map((skill) => ({ skill, depth: reached.get(skill)!.length - 1, via: reached.get(skill)! })));
    level = next.toSorted();
  }
  return out;
}

function impactIn(result: WorkflowCheck, changed: string): Reach[] {
  if (!result.skills.some((skill) => skill.name === changed)) {
    const where = result.isSet ? "the set" : result.folder;
    throw new UserError(`${changed} isn't a skill in ${where}.\n\nNext: run \`moro check\` to see the skills it reads.`);
  }
  return impactOf(result.calls, changed);
}

function findingLines(findings: Finding[]): string[] {
  return findings.map((finding) => `  ${finding.message}`);
}

function impactLines(changed: string, impact: Reach[]): string[] {
  if (impact.length === 0) return [`Impact of a change to ${changed}: no skill calls it.`];
  return [
    `Impact of a change to ${changed}:`,
    ...impact.map(({ depth, skill, via }) => (depth === 1 ? `  direct    ${skill}` : `  indirect  ${via.join(" -> ")}`)),
  ];
}

/**
 * What sync prints after an accept: the check's findings on the set, as a warning,
 * followed by a blank line; nothing when the skills fit together.
 */
export function checkWarning(setDir: string): string {
  const { findings } = workflowCheck(setDir);
  if (findings.length === 0) return "";
  const count = `${findings.length} problem${findings.length === 1 ? "" : "s"}`;
  return [
    `Warning: the workflow check found ${count} in the set; fix them before you push (\`moro check\` lists them again):`,
    ...findingLines(findings),
    "",
    "",
  ].join("\n");
}

/** What `moro sync show` says about the skills a change to `key` reaches. */
export function impactSummary(setDir: string, key: string): string {
  const impact = impactOf(workflowCheck(setDir).calls, key);
  if (impact.length === 0) return `Impact: no skill in the set calls ${key}.`;
  const direct = impact.filter((reach) => reach.depth === 1).map((reach) => reach.skill);
  const indirect = impact
    .filter((reach) => reach.depth > 1)
    .map(({ skill, via }) => `${skill} through ${via.slice(1, -1).join(" and ")} (${via.join(" -> ")})`);
  return `Impact: ${direct.join(", ")} call${direct.length === 1 ? "s" : ""} ${key} directly${indirect.length > 0 ? `; ${indirect.join("; ")}` : ""}.`;
}

/** Folders a walk never enters. */
const SKIPPED = new Set([".git", "node_modules"]);

/**
 * The skills under `folder`: in a set, those in `skills/` and `skills.local/`; elsewhere, every
 * `SKILL.md` outside `.git` and `node_modules`. Symlinked folders aren't followed, and the first
 * skill of a name wins.
 */
function readSkills(folder: string, isSet: boolean): CheckedSkill[] {
  const roots = isSet ? [SKILLS_DIR, LOCAL_ONLY_DIR].map((root) => join(folder, root)).filter((root) => existsSync(root)) : [folder];
  const seen = new Set<string>();
  const skills: CheckedSkill[] = [];
  for (const file of roots.flatMap(skillFiles)) {
    const text = readFileSync(file, "utf8");
    const path = relative(folder, join(file, ".."));
    const name = frontmatterName(text) ?? basename(path);
    if (seen.has(name)) continue;
    seen.add(name);
    skills.push({ name, path, text });
  }
  return skills;
}

function skillFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => a.name.localeCompare(b.name));
  return entries.flatMap((entry) => {
    if (entry.isFile() && entry.name === "SKILL.md") return [join(dir, entry.name)];
    if (entry.isDirectory() && !SKIPPED.has(entry.name)) return skillFiles(join(dir, entry.name));
    return [];
  });
}
