# Feature: (name)

<!-- Copy this file to docs/design/<feature>.md and fill it in. You own the design;
Claude implements it. The italic lines are an example (a dash move): replace them.
Mark anything you're unsure about with (?) so Claude asks instead of guessing. -->

- **Status:** draft | approved | built | tuned
- **Related:** (other specs, playtest notes, reference games or clips)

## Player goal
One or two sentences, from the player's point of view: what they want to do and why it's fun.

_Dash through a gap before the door closes, so movement feels sharp and skillful._

## Rules
Exact behaviour, as numbered statements Claude can turn into code and tests.

1. _When the player presses Dash and the cooldown is ready, they move `dashDistance` in the facing direction over `dashDuration`._
2. _The player is invulnerable during the dash._
3. ...

## Tunables
Every number lives in data (`data/...`), never hard-coded in logic.

| Name | Default | Unit | Sensible range | Data file | What it changes |
|---|---|---|---|---|---|
| _`dashDistance`_ | _8_ | _tiles_ | _4-12_ | _`data/player.json`_ | _How far one dash goes_ |
| _`dashDuration`_ | _0.2_ | _s_ | _0.1-0.3_ | _`data/player.json`_ | _How snappy it feels_ |
| _`dashCooldown`_ | _1.5_ | _s_ | _0.5-3_ | _`data/player.json`_ | _How often it can be used_ |

## Edge cases
What happens when...
- _Dashing into a wall: stop at the wall, no clipping._
- _Dash pressed during cooldown: nothing happens, play a "not ready" cue._
- _Dash at a ledge, while hit, while paused, with 0 health, on the first or last frame._

## Feel target
What it should feel like, in words and references.

_Snappy like Celeste's dash: instant start, a short freeze-frame on hit, a small screen shake. Never floaty._

- Feedback: _visuals, sound, camera, controller rumble_

## Acceptance checks
Automated (Claude writes these as unit tests in `src/core/`):
- [ ] _Dash moves exactly `dashDistance` when nothing blocks it._
- [ ] _Dash stops at a wall._
- [ ] _A second dash within `dashCooldown` is ignored._

Playtest (you check these by playing):
- [ ] _The dash feels instant: no visible delay after the key press._
- [ ] _You can reliably dash through a 2-tile gap._

## Out of scope
- _What this feature deliberately does not do yet, e.g. air dash._

## Open questions
- _Undecided items. Claude asks about these instead of guessing._
