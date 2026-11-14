# Sync decides per skill, not per upstream commit

Sync offers one decision per upstream skill: the whole difference between the source at the pin and the source's latest commit, with the rename rules applied, plus the commit subjects and changesets for context. Deciding per upstream commit looks finer-grained but fails on real history: Matt's main line is mostly merges, and his v1.3 release merge alone changes 13 skills. The commits inside it sit on side branches that weren't based on the pins, so they can't be applied one at a time. Diffing only the two end points doesn't depend on the shape of the history (prototype: `.scratch/personal-skill-set/assets/04-sync-prototype/`).

## Consequences

- There's no partial accept. To take part of a skill's change, accept it and hand-edit the rest back out, or skip it and hand-edit the wanted part in.
- A change that sweeps across skills, such as a convention rename, is decided skill by skill. When the owner wants to hold back a convention everywhere, a rename rule does it in one place (ADR 0002).
