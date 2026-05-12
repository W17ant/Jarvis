## What this changes

<!-- One sentence: the user-visible effect. Not the implementation. -->

## Why

<!-- The constraint, request, or bug that drove the change. -->

## How

<!-- Brief implementation notes. Skip if the diff is self-explanatory. -->

## Test plan

- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (137+ tests)
- [ ] Manually smoke-tested in a Chrome window pointed at `http://localhost:8765`
- [ ] If the change touches the voice loop, verified one full wake → STT → LLM → TTS turn end-to-end
- [ ] If the change touches the HUD, hard-refreshed (Cmd+Shift+R) and checked at full kiosk size

## Documentation

- [ ] CHANGELOG.md updated under the right `[x.y.z]` header
- [ ] If a new tool / plugin / config knob landed, it's mentioned in the relevant `docs/*.md`
- [ ] If a new env var landed, it's mentioned in the install guide

## Operator impact

<!-- Will this require a `./launch.sh restart`? A re-pull? Any data migration?
A change to `.env`? Default behaviour change? Be explicit so operators reading
the changelog know what to do. -->

- Restart required: yes / no
- Data migration: yes / no
- Default behaviour change: yes / no

## Screenshots / clips

<!-- For HUD or settings changes, attach a before/after. For voice changes,
a screen-recording with audio is gold. -->
