# Moro Skills

The owner's private set of agent skills: skills copied from other repos and skills the owner writes, installed on the owner's machines from one repo.

## Language

**Skill set**:
Every skill this repo holds, installed together as the owner's own set and named after the owner's nickname, moro.
_Avoid_: plugin, collection, library

**Source**:
A repo the skill set copies skills from, such as Matt Pocock's skills or pstack.
_Avoid_: upstream repo, vendor, origin

**Upstream skill**:
A skill copied from a source and pinned to one of its commits. Its text is the source's text with that source's rename rules applied, plus any hand edits.
_Avoid_: vendored skill, third-party skill, Matt's skill

**Own skill**:
A skill with no source: one the owner wrote, or an upstream skill the owner detached from its source by dropping it from the manifest.
_Avoid_: custom skill, personal skill

**Pin**:
The commit of its source that an upstream skill was last taken from.
_Avoid_: version, lock

**Manifest**:
The skill set's record of its sources and upstream skills: each source's rename rules, and for each upstream skill its source, where it sits in the source, and its pin.
_Avoid_: lock file, registry

**Rename rule**:
A literal, whole-word substitution that a source's text and file names always go through on their way into the skill set, such as turning Matt's names into moro ones, or keeping `CONTEXT.md` where Matt now says `GLOSSARY.md`.
_Avoid_: rebrand, patch, replacement

**Hand edit**:
A change the owner made to an upstream skill beyond its rename rules: the difference between the skill set's copy and the source's text at the pin with the rename rules applied.
_Avoid_: local edit, customisation, override

**Intake**:
Bringing a skill from a source into the skill set as an upstream skill: the source's text at a commit, with that source's rename rules applied and nothing else changed, which becomes the skill's first pin.
_Avoid_: import, vendoring, install

**Lock file**:
The `skills` CLI's record of what is installed on one machine. It belongs to the machine, not to the skill set.
_Avoid_: manifest

**Upstream change**:
A change a source made to an upstream skill after its pin.
_Avoid_: update, patch

**Sync**:
Reviewing the upstream changes since each pin, one upstream skill at a time, and accepting or skipping each skill's change as a whole.
_Avoid_: update, upgrade, pull

**Skipped change**:
An upstream change the owner declined for one upstream skill. The pin moves past it anyway, the manifest lists its commits under that skill, and from then on the set's copy keeps it out as part of the skill's hand edits.
_Avoid_: rejected change, ignored update

**work skill**:
A skill about the owner's company work, installed only on machines where the owner opts in. Being a work skill has nothing to do with origin: a work skill can be upstream or own.
_Avoid_: comp skill, company skill

**work machine**:
A machine where the owner opted into work skills. The opt-in is the owner's recorded choice for that machine, not whatever happens to be installed on it.
_Avoid_: company laptop

**Refresh**:
Bringing one machine's installed skills in line with the skill set and that machine's choices: installing skills new to the set, removing skills the set no longer holds, and removing work skills from a machine that isn't a work machine. Sync is upkeep of the set; refresh is upkeep of a machine.
_Avoid_: update, install, sync

**Left-out skill**:
A skill in the set that the owner chose not to install on a given machine. The choice is recorded for that machine, so refresh doesn't offer the skill again. A skill that is merely not installed isn't left out.
_Avoid_: excluded skill, skipped skill

**Loose skill**:
A skill folder on a machine that the machine's lock file doesn't record, such as one the owner wrote straight into the skills folder. When the set holds a skill with the same name, the set's copy replaces it, after the owner has seen how the two differ.
_Avoid_: local skill, unlocked folder, untracked skill, stray skill

**Machine setup**:
Making one machine ready for the skill set: confirming it can reach the set, choosing its skills and whether it's a work machine, retiring what the set replaces (copies of its skills installed from their sources, skills from those sources it didn't take, and loose skills it holds), and ending with a refresh. Rerunning it is how a machine's choices change.
_Avoid_: setup (alone), install, init

**Repo setup**:
Making one project repo ready for the set's engineering skills: its issue tracker, triage labels and domain docs. It belongs to a project, not to a machine or to the set.
_Avoid_: setup (alone), project config
