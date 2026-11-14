---
name: debugging-playbook
description: Turn the debugging session just finished into a teaching playbook saved in ~/Desktop/investigations/.
disable-model-invocation: true
---

# Debugging playbook

Write a **lesson**, not a report. The reader is the user learning to debug: the playbook replays this session's **trail** so the next bug of the same class can be diagnosed the same way.

## Steps

1. **Folder.** `~/Desktop/investigations/<YYYY-MM-DD>-<kebab-symptom>/`, where the slug names the symptom, not the fix. Arguments, if given, are the slug. If the folder already exists (it holds `bug-report.md`, `handoff.md`), write beside them. The file is `debugging-playbook.md`.
2. **Trail.** Walk the transcript in order and list every input (messages, pasted artifacts, links), every **probe** (a command or tool call whose output changed belief, with its key output), every hypothesis and the probe that killed or confirmed it, and every **dead end** (blocked route, error signal, route taken instead). Done when every belief-changing probe is listed.
3. **Steps.** Group probes by the question each answered, in the order the search narrowed. Done when every probe sits in a step or in the dead-ends table.
4. **Write** to the format below. If writing to `~/Desktop` is denied, write to the scratchpad and `mv` it with the sandbox off.
5. **Reply** with the full path and three lines: the root cause, the probe that cracked it, and the most reusable trick.

## Writing rules

- Commands verbatim, as run. Output as `#  →` lines trimmed to the signal. `<placeholders>` only inside recipes.
- Every finding cites its probe. Anything unproven is *likely* or *unverified*.
- Secrets and personal data become `<REDACTED>`. Commit authors are left unnamed.
- Narrate decisions through evidence: what was weighed, what won, why.

## Format

````markdown
# Debugging playbook: <symptom>

A worked case study: how the bug was narrowed from "<user's first words>" to <root cause>, with the exact commands used. Each step lists what was known, what was done, the command, what it showed, and how it narrowed the search.

## 0. Mindset
<3–6 numbered **bold rules.**, each grounded in this case in one or two sentences>

## 1. Read the symptom precisely
**Input:** "<user's words>"
**What was taken from it:** <bullets: signal → implication>

## <N>. <Question as an imperative, e.g. "Bound the change">
<one-line goal>
```bash
# <why>
<command as run>
#  → <the line that mattered>
```
**Finding:** … then **What that ruled out:** / **Hypothesis formed:** / **Where the search stood:** …
> **Reusable trick:** / **Gotcha:** / **Reusable recipe, "<recurring question>":** <generalized commands>

## <N>. Decide where to fix it            ← only if several fixes were weighed
| Option | How it was evaluated |

## <N>. Confirm on the real environment  ← only if a live check exists
<smallest pasteable check, with the bug value and the fixed value>

## <N>. Dead ends and how each was handled
| Blocker | Signal | What was done instead |

## <N>. Checklist for the next "<bug class>" bug
<numbered imperatives, generalized>
````

Include a reproduction step whenever the session built one: the script trimmed to what shows the mechanism, plus its red/green output.
