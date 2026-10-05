# Bounded lower-zone expression candidate

Status: CANDIDATE. `mpeExpression` is an expression-routing primitive for a manually configured MIDI 1.0 lower zone. It is not a complete MPE receiver, MPE compliance certification, a voice allocator, a pedal implementation, a MIDI runtime or an instrument.

## Entry and values

The public entry is `@denaudio/den/mpe-expression`, exporting `mpeExpression`, `MpeExpressionConfig` and `MpeExpressionVoice`.

Instantiate `mpeExpression({ memberChannels, memberBendRange, masterBendRange })` once. `memberChannels` is a fixed integer 1..15, default 15. Native channels are zero-based: master channel 0 (musician-facing channel 1), member channels 1..N (musician-facing channels 2..N+1). Bind once to the same existing `event.midi({from:'main',name:...})` handle as `performancePolicy` or `voicePolicy`. Multiple native handlers share the port; the module neither wraps nor resends MIDI.

Pass an allocator voice's unchanged `active` and `channel` fields to `read(voice)`. The returned `inZone` is true only for an active member channel. Every numeric output is zero for inactive voices, master-channel notes, channels outside the configured zone or invalid channel indices. A clamped internal buffer index never turns an invalid channel into a valid member.

- `memberBend` and `masterBend`: normalized -1..1. MIDI bend 8192 is exactly zero; 0 is -1 and 16383 is +1. The negative half divides by 8192 and positive half by 8191.
- `bendSemitones`: member normalized bend times `memberBendRange`, plus master normalized bend times `masterBendRange`. Ranges are symmetric semitones, finite 0..96, construction-fixed, with defaults 48 and 2 respectively. Addition uses f64 intermediates and one final f32 conversion. No clipping or note-frequency conversion is applied here.
- `memberPressure` and `masterPressure`: channel-pressure bytes normalized 0..127 to 0..1, initially zero. These are separate lanes. A composition chooses how they affect sound and whether to combine them.
- `memberTimbre` and `masterTimbre`: CC74 bytes normalized 0..127 to 0..1, initially 64/127. The default is the exact MIDI byte center, approximately 0.503937, not 0.5. Raw timbre is not intrinsically bipolar. These are separate lanes with no invented timbre destination or combination law.

Use `bendSemitones` exactly once in the pitch path. When composing with `performancePolicy`, do not also add its `bend`, which represents the same member-channel message. Add any independently desired tuning/transpose controls separately. Pressure/timbre from the existing policy also represent the same incoming bytes and must not be accidentally applied twice. No pitch smoothing is provided.

## Notes, tails, steals and pedals

The existing allocation policy alone owns note-on/off, velocity-zero note-on, duplicate pairing, held identities, overflow, voice stealing, mono priority, gate/retrigger, pedal and release completion. This module does not filter notes admitted by that policy. A composition wanting member-only sound must use `inZone` to gate its output; master/out-of-zone notes can still consume allocator slots.

Expression is channel state, not a per-note identifier or voice-slot cache. It can be set before note-on and persists after note-off. Every active voice carrying that member channel observes the current channel expression, including multiple same-key identities and release tails. Reusing a member channel while an old tail remains means both the new note and old tail receive later changes. A stolen physical slot immediately reads its replacement's channel; the stolen identity's later note-off retains the original allocator semantics. A free slot emits zero expression. Notes, note-offs, steals, CC120, CC123 and release completion do not themselves reset expression.

With `performancePolicy`, member-channel CC64 sustain continues to work as documented there. Master-channel CC64 is NOT propagated to members. Master CC120 and CC123 also do not become zone-wide panic/all-notes-off. Their handling remains the original allocator's channel-local behavior. This intentionally limited primitive is unsuitable as a drop-in full MPE pedal receiver.

## Reset, timing and snapshots

CC121 resets only the addressed master/member expression state to bend center, pressure zero and timbre byte 64. Master CC121 resets the master lanes only. It does not reset every member. The original allocator/performance policy independently handles that same CC according to its own contract, including its different legacy timbre default. This module's outputs are authoritative for its expression path.

`reset(true)` resets every expression channel; `reset(false)` does nothing. Reset is level-sensitive and does not clear notes, stop audio, raise pedals, generate retriggers, or reset DSP. A composition's full panic must explicitly call the allocation policy reset and clear its envelopes/oscillators as appropriate. Call expression reset after native dispatch if reset should win over MIDI in the same quantum.

All state is native transient integer state and is excluded from the snapshot. A **fresh-instance** restore (including `renderOffline` into a new driver) starts from centered bend, zero pressure and timbre byte 64. Native 0.4.1 **in-place** `node.restore()` only overlays saved slots: it leaves the current expression, notes and pedals unchanged. It neither recalls excluded gestures from the blob nor clears current ones. For a cold in-place restore, use the composition's existing explicit reset for expression, allocation policy and DSP after restoring; let at least one quantum render before fresh notes. Expression-only reset cannot clear notes or silence an orphan envelope. A composition must also clear persistent voice DSP whenever its note identity is absent.

Native unworklet 0.4.1 dispatch is FIFO before each 128-sample process quantum. Multiple messages in a quantum coalesce to the final state. A nominal sample-129 event affects boundary 128. No sample-accurate scheduling, new transport or hardware MIDI claim is made.

## Deliberate exclusions

No upper zone, dynamic zone/RPN negotiation, RPN bend-range updates, MIDI-CI/MIDI 2.0, polyphonic key-pressure interpretation, master-pedal propagation, external MIDI host/device verification or per-note release-tail freezing is implemented. Unsupported messages are ignored by this expression primitive, while other handlers on the native input retain their own behavior.

The MIDI Association's [MPE overview](https://midi.org/midi-polyphonic-expression-mpe-specification-adopted) explains member-channel expression and zone-wide master control. The primitive implements only the manually configured expression subset documented above. The broader catalog's full MPE gap remains open.

## Evidence

The 35 focused tests use byte fixtures with an independent ordinary-object state model at 44.1, 48 and 96 kHz. They cover master/member isolation and bend addition, endpoint/center values, duplicate FIFO pairing, steals and stale note-offs, channel reuse/tails, per-member sustain, explicitly absent master pedal/panic propagation, channel-local CC121, expression-only versus composition-wide reset, empty transient snapshots, unsupported controllers/RPN, native handler registration order and all 15 members.

The packed consumer gate requires strict public-subpath TypeScript, native MIDI/envelope/oscillator rendering at the three offline rates, independent pitch/amplitude equations, zero scrubbed samples, snapshot silence and fresh-note safety. Maximum configured member count is storage coverage, not 15-voice allocation or real-time clearance. No browser, hardware, listening approval or approved golden follows from offline evidence.

The diagnostic composition routes pitch as note plus `bendSemitones`, then applies separate tuning controls. Its amplitude is velocity times a linear envelope times (0.5 + 0.25 member pressure + 0.25 master pressure) times (0.5 + 0.25 member timbre + 0.25 master timbre), with output gain 0.2. This is an explicit test routing, not a standardized MPE sound or preset. The initial packed proof reports zero pitch/level error, maximum audio error below 3.3e-8 and four-voice chord error below 7.7e-8. The four-voice/eight-identity/15-member composition is 719,110 WASM bytes with 65,536 bytes of memory, unchanged over 256 driver blocks. These are functional/fixed-memory results, not deadline clearance. Exact-head package/source/lock hashes and CANDIDATE status are retained in the generated manifest and result pair.

## Retained live-restore finding

The first integrated browser probe on `ed061ca` expected a centered fresh note
after in-place restore, but observed 187.5 Hz rather than 375 Hz: the current master
bend of −12 semitones was correctly retained by the native overlay. The fresh-
driver offline test had not exercised this lifecycle. The corrected browser
contract separately checks continued held notes/current expression, silence
when the current note was already released, inherited master expression on a
new member note, and centered fresh-note audio only after explicit composition
reset has rendered. This diagnostic composition also tests reset-before-restore
when a quantum has completed first: its inactive-voice guards clear the restored
persistent envelope/oscillator tail. General compositions should use the explicit
reset-after-restore sequence above unless their own ordering is verified. DSP
statements and upstream restoration are unchanged.
