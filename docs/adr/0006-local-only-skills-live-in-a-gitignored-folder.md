# Local-only skills live in a gitignored `local-only/` folder

Skills that belong on one device (company work, for example) sit in the clone's `local-only/<group>/<name>`, which `.gitignore` keeps out of every commit, so they never reach GitHub or another device. They are own skills only: the committed manifest never names them, and the recommended list covers them all as `local-only/*`. This replaces the opt-in `work/` folder of ADR 0001, whose skills were pushed to the shared repo and filtered per device.

## Consequences

- Nothing syncs a local-only skill, and a device that loses its clone loses them: the owner keeps them elsewhere if they matter.
- A project install always keeps local-only skills out of the project's git, even in a project that commits its other skills.
- Names stay unique across `skills/` and `local-only/`, because a project installs both into one folder.
- A project that commits its skills also commits `skills-lock.json`, which names its local-only skills and the clone's relative path to them. The lock's sources are device-specific for every skill, so another device reads them as folders that may not exist. Keep a project out of git (the install's keep-out answer) when its local-only skill names must stay private.
