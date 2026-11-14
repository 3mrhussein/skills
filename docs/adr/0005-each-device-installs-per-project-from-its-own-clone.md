# Each device installs per project, from its own clone

Every device clones the set and installs from that clone, never from GitHub. Skills go into each project as copies, picked per project; at user level the set puts only `/setup-moro-skills`. GitHub only carries commits between clones, and moro never fetches or pulls. The owner wants the clone on a device to be the one source of truth there, and each project to hold the skills it uses.

## Considered options

- Install at user level from GitHub (`npx skills add 3mrhussein/skills -g`), the earlier plan: one install per device, but the device's own edits and device-only skills had no path in.
- Symlink each project's skills into the clone (Matt's `scripts/link-skills.sh`): live after every edit, but the links name one device's path, so a project that commits its skills would commit links that work nowhere else.
- Track every project a device set up and refresh them all at once: one more record to keep honest; the owner chose to rerun the project install in the project that needs it.

## Consequences

- `skills update` skips local-path installs, so a project only catches up when its project install reruns. The divergence scan says when it should.
- A user-level skill shadows a project skill of the same name in Claude Code, so bootstrap retires the shadowing skills the owner picks. Other user-level skills stay: the owner may keep skills the set doesn't hold, and they hide nothing.
- The CLI is built from the clone and is never published to npm.
