# Moro Skills

The owner's own set of agent skills: skills copied from other repos and skills the owner writes, kept in one repo that each device clones and installs from, one project at a time.

## Language

### The set

**Skill set**:
Every skill this repo holds, named after the owner's nickname, moro.
_Avoid_: plugin, collection, library

**Clone**:
A device's copy of the skill set's repo. On that device it is the only source the set's skills install from.
_Avoid_: checkout, local repo, mirror

**Group**:
A folder of the set that skills sit in, such as `engineering`. Every skill belongs to exactly one group.
_Avoid_: bucket, category

**Local-only skill**:
A skill kept in one clone's `skills.local/` folder and never pushed, so it exists on that device alone.
_Avoid_: private skill, device skill, work skill

**Recommended skill**:
A skill the set offers ticked when a project first installs. Every local-only skill is recommended.
_Avoid_: default skill, core skill

**Experimental skill**:
A skill in the set that isn't recommended: offered, but not ticked.
_Avoid_: optional skill, beta skill

**Required skill**:
A recommended skill that drives the owner's workflow, so a project can't leave it out.
_Avoid_: core skill, mandatory skill

**Dependency**:
A skill that another skill needs installed next to it. A project can't leave out a dependency of a skill it keeps.
_Avoid_: requirement, prerequisite

### Where skills come from

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
The skill set's record of its sources, upstream skills, recommended and required skills, and dependencies.
_Avoid_: lock file, registry

**Rename rule**:
A literal, whole-word substitution that a source's text and file names always go through on their way into the skill set, such as turning Matt's names into moro ones.
_Avoid_: rebrand, patch, replacement

**Hand edit**:
A change the owner made to an upstream skill beyond its rename rules: the difference between the skill set's copy and the source's text at the pin with the rename rules applied.
_Avoid_: local edit, customisation, override, tweak

**Intake**:
Bringing a skill from a source into the skill set as an upstream skill: the source's text at a commit, with that source's rename rules applied and nothing else changed, which becomes the skill's first pin.
_Avoid_: import, vendoring

**Upstream change**:
A change a source made to an upstream skill after its pin.
_Avoid_: update, patch

**Sync**:
Reviewing the upstream changes since each pin, one upstream skill at a time, and accepting, skipping or falling back on each skill's change as a whole.
_Avoid_: update, upgrade, pull

**Fallback**:
Taking an upstream change by dropping the skill's hand edits, so that the set's copy becomes the source's latest text with its rename rules applied.
_Avoid_: reset, revert, original

**Skipped change**:
An upstream change the owner declined for one upstream skill. The pin moves past it anyway, the manifest lists its commits under that skill, and from then on the set's copy keeps it out as part of the skill's hand edits.
_Avoid_: rejected change, ignored update

### Trying and checking

**Candidate**:
One way to take an upstream change to a skill with hand edits: the fallback, or the adapted copy, where the hand edits are merged with the change.
_Avoid_: variant, option

**Trial**:
Trying a skill's candidates side by side before one reaches the set: each on its own branch of the clone, used in projects that install from that branch.
_Avoid_: lab, sandbox, experiment

**Workflow check**:
Checking that the set's skills still fit together: every skill another skill calls is in the set, can be called, and is listed among the caller's dependencies.
_Avoid_: compatibility check, lint

**Impact**:
The skills a change to one skill reaches through the skills that call it: its callers directly, and their callers indirectly.
_Avoid_: blast radius, dependents

**Audit**:
Comparing each skill at three layers: its source (has it moved past the pin?), the set (is the copy the source's text or hand-edited?) and the current project (does its copy match the set's?).
_Avoid_: gate, status, report

### Devices and projects

**Bootstrap**:
Making one device ready: building the CLI from the clone, recording where the clone is, putting `/setup-moro-skills` at user level, and retiring the shadowing skills the owner picks. Every other user-level skill stays.
_Avoid_: machine setup, install, init

**Entry skill**:
`/setup-moro-skills`: the one skill bootstrap keeps at user level on every device, and the default way to set up a project, ahead of the CLI. Project installs leave it out, and it is never a shadowing skill.
_Avoid_: bootstrap skill, setup skill

**Project install**:
Copying the skills a project picks from the device's clone into that project. Rerunning it is how a project catches up with the clone.
_Avoid_: setup (alone), refresh, sync

**Divergence**:
A difference between a project's installed skills and the clone: the set changed a skill, the project edited its copy, the set no longer holds it, or a set skill isn't installed.
_Avoid_: drift, staleness, update

**Repo setup**:
Making one project repo ready for the set's engineering skills: its issue tracker, triage labels and domain docs.
_Avoid_: setup (alone), project config

**Lock file**:
The `skills` CLI's record of what is installed in one project or at user level. It belongs to that project or device, not to the skill set.
_Avoid_: manifest

**Loose skill**:
A skill folder in a project, or at user level, that the lock file there doesn't record, such as one the owner wrote straight into the skills folder.
_Avoid_: local skill, unlocked folder, untracked skill, stray skill

**Shadowing skill**:
A user-level skill with the same name as a skill in the set, which hides a project's copy of that skill. One taken from the same upstream skill as a set skill counts too, whatever its name.
_Avoid_: conflict, clash, duplicate
