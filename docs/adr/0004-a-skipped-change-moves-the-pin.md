# A skipped upstream change still moves the pin

When the owner skips an upstream skill's change, sync keeps the set's copy as it is, moves the pin to the source's latest commit anyway, and lists the skipped commits under `skipped` in that skill's manifest entry. The skipped change then sits inside the skill's hand edits (the difference from the source at the pin, renamed), so later three-way merges keep it out with no extra bookkeeping, and it is never offered again. The `skipped` list only explains why the copy differs and leaves a way back. A skill the owner hasn't decided on records nothing and comes back at the next sync.

## Considered options

- Keep the pin and record the skipped commits, so sync subtracts them from later changes: needs reverse-applying old commits on every sync, which breaks once upstream edits the same lines.
- Keep the pin and offer the change again with the next one: a skip wouldn't stay skipped.
- Move the pin with no record: works the same, but a skipped change then looks like an unexplained hand edit.
