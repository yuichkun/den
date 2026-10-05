# Voice policy integration (GEN-616)

`src/voice-policy.ts` provides a construction-time fixed-capacity unworklet subgraph. It allocates voices and emits control values; it contains no oscillator, envelope, filter, audio mixing, or MIDI transport. The public package subpath is `@denaudio/den/voice-policy`. The isolated entry consumer checks its types and renders note-on/note-off gate behavior at 44.1/48/96 kHz.

Instantiate with a required configuration and an explicit instance name (the same workaround for unworklet #104 used by the entry gate). Call `bindMidi` once in declaration scope with an existing `event.midi({ from: 'main', name: 'midi' })` input. The host sends through unworklet's existing node MIDI API. Alternatively, invoke the graph methods from existing graph event handlers. Arguments are unworklet nodes, not host numbers.

| Contract | Behavior |
| --- | --- |
| `mode` | Required `mono` or `poly`; mono uses one voice. |
| `capacity` | Poly defaults to 16, configurable 1–32; mono requires 1. |
| `heldCapacity` | Defaults to 128; configurable from voice capacity through 256. Counts accepted, still-held note-on identities, including stolen notes. |
| `legato` | Mono defaults to true. True preserves gate and suppresses retriggers when held-note priority changes. False retriggers on changes and fallbacks. |
| `voices[n].read()` | Graph nodes: `active`, `gate`, integer MIDI `note`, integer `channel`, normalized `velocity`. Inactive note/channel are -1 and velocity is zero. |
| `voices[n].takeRetrigger()` | Returns and clears a latched start/retrigger. Consume once per sample before the envelope; share that returned node if several consumers need it. |
| `voices[n].releaseFinished(done)` | Frees a released voice on envelope completion. Never frees a currently held replacement. Call with the envelope's current completion signal. |
| `noteOn(note, channel, velocity)` / `noteOff(note, channel)` | Channels 0–15, notes 0–127, velocities 0–127. Velocity-zero note-on is note-off. Invalid graph values are ignored. |
| `allNotesOff(channel)` | Removes held keys for that channel and starts their release; mono may fall back to another channel's held note. |
| `allSoundOff(channel)` | Removes keys and immediately frees that channel's voices; mono may fall back to another channel. |
| `reset(when)` | Immediately clears every voice, held identity, pending retrigger and overflow flag when true. Default condition is true. |
| `overflowed()` | Latched boolean cleared by reset. Signals rejected note-ons when the held ledger is full. |

The capacity defaults and ceilings are implementation bounds for the generated graph, not approved product limits. No runtime capacity changes or dynamic allocation are introduced.

Poly chooses the lowest-index free slot, then the oldest released slot, then steals the oldest held slot. Allocation and release ranks remain bounded by capacity. Duplicate note-offs consume the oldest outstanding matching channel/note identity. Stolen identities remain in the bounded held ledger, so their later note-offs cannot release a newer duplicate. Mono chooses the most recently held identity and falls back through still-held identities. Duplicate identities retain their own velocity and channel.

A full held ledger rejects new note-ons and latches overflow; it does not evict accepted identities. This preserves release bookkeeping for accepted notes. MIDI 1.0 contains no per-note identity, so interleaved note-offs for rejected duplicate pitches cannot be distinguished from accepted duplicate pitches. FIFO pairing is the explicit policy. Reset or channel all-sound-off clears retained identities. Sustain CC64 and other controllers are not implemented; bindMidi handles CC123 and CC120 only.

Unworklet 0.4.1 drains MIDI at block boundaries in FIFO order, before processing samples. Generic control messages drain before MIDI in the same block. This module preserves those semantics; it does not add a sample-accurate event scheduler. Multiple starts in a block coalesce to one retrigger latch and the final voice assignment. An on/off pair in one block may produce a retrigger with gate already low; envelope integration must define that case. Do not claim sample-accurate MIDI from these tests.

All voice and held-key storage uses unworklet transient state. Snapshots exclude live held notes. A fresh instance therefore starts empty, while native in-place restore leaves currently held notes unchanged. Use explicit reset for a cold live restore; no new snapshot/preset serializer is provided. A reset is the explicit panic operation. Completion signals belong to the current envelope attached to each slot; a delayed completion from a previous released assignment must not be reused after a steal and subsequent release.

## Verification

The numerical fixture renders voice state through diagnostic outputs using published unworklet 0.4.1. It checks FIFO duplicates, stolen-note releases, release reuse, mono priority/legato/retrigger, channel controls, reset, independent instances, bounded overflow and repeated reuse. These outputs are diagnostics, not audition audio or approved goldens. Offline 44.1/48/96 kHz tests do not extend the browser gate's existing 48 kHz support claim.

Upstream issue #99 is independently reproduced: `expectMidiBalance` counts velocity-zero note-on as another held note. Den uses explicit numerical gate/identity assertions instead. The fixture stays inside the last render quantum to avoid the independently reproduced #96 duration rounding issue. No dependency changes or helper patches are made.

Capacity probes also exposed recursive expression expansion in unworklet's analysis of nested selects. Transient scratch accumulators keep the traversal and selection expressions shallow. Before this change the default-capacity test was stopped after more than one minute of CPU work; afterward the full numerical suite including capacity probes ran in seconds. A 64-voice/256-held diagnostic graph failed WebAssembly compilation with `local count too large`; the supported construction ceiling is therefore 32 voices, tested with 256 held identities. Larger combined instrument graphs still require their own compile and runtime budget checks. The current release-completion path performs rank maintenance across slots; passing these fixtures does not establish a real-time CPU budget for a complete instrument.
