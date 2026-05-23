# Known Issues

Behaviours observed against shipping providers that you may run into in
production. Each entry documents the symptom, the root cause, what the
framework already does to mitigate it, and the knobs available for further
tuning.

## OpenAI Realtime can interrupt itself via echo on subsequent responses

### Symptom

The assistant starts speaking, then cuts itself off mid-sentence. The
conversation history shows a "user" turn containing a fragment of the
assistant's own words. Example from a real session log:

```text
05:16:53.682 [Latency] User voice input started (peak=1627; avgAbs=245)
05:16:53.843 Interrupted by user
05:16:53.844 Turn complete: turn_2
05:16:53.845   [assistant] Let me think about how I can help with that.
05:16:55.640 [Latency] Input transcription update text="Let me..."
05:16:57.662 [Usage] turn=turn_3 …
05:17:03.695   [assistant] I heard you say "Let me." I did not catch the rest.
              Can you say it again, yes or no?
```

The "Let me…" was the assistant's own audio leaking back through the mic;
OpenAI's input-transcription path then re-ingested it as user speech and a
new turn was generated asking the user to clarify what they "said".

### Root cause

Two factors compound:

1. **Under-converged browser AEC.** WebRTC AEC3 needs a non-silent reference
   signal (the assistant's audio playing on speakers) to learn the
   speaker-to-mic transfer function. If the user interrupts the first
   greeting quickly, AEC only had a moment to start converging. A multi-second
   silent gap before the next response can further stall the adaptive filter.
   When the next response plays, echo at the mic can be substantial —
   typical peak amplitudes of 1500–2000 are common during the under-converged
   window.
2. **OpenAI semantic_vad is sensitive on `eagerness: 'medium'` or higher.**
   The server-side VAD fires `input_audio_buffer.speech_started` even on
   low-amplitude residual echo. With `interrupt_response: false` (the
   framework's default), the framework treats that signal as a real barge-in
   and cancels the in-flight response.

The framework's client-VAD echo floor (`bargeInTtsPeakThreshold: 2000`,
`bargeInTtsAvgAbsThreshold: 450`) **correctly rejects** these low-amplitude
events on the client side — but the interrupt actually originates from
OpenAI's server VAD, which the client thresholds do not gate.

### What the framework already does

- **Greeting interrupt grace window** (default 1000 ms on OpenAI). Suppresses
  user-driven interrupts and drops outbound mic frames during the session's
  first assistant audio, giving AEC time to start converging without echo
  feeding back. See
  [`dev_docs/framework/design-greeting-interrupt-grace.md`](https://github.com/bodhi-tech/bodhi_realtime_agent_framework/blob/main/dev_docs/framework/design-greeting-interrupt-grace.md).
- **Default `eagerness: 'low'`** for `semantic_vad`. Makes the server VAD
  require slightly more sustained speech to fire `speech_started`, rejecting
  most under-converged echo. This is the framework's primary defence against
  the issue described here.

The greeting grace **only covers the session's first audio**. It does **not**
re-arm for subsequent responses — by design, since AEC convergence is meant
to be one-shot per audio context.

### When you still hit it

The combined defences are not perfect. You may still see false barge-ins if:

- The user interrupts the greeting within ~500 ms (AEC barely converged).
- The conversation has long silent gaps between responses.
- Playback is on laptop / phone speakers without good hardware AEC.
- The mic has high gain or is physically close to the speakers.

### Mitigations

In order of preference:

1. **Use headphones.** Eliminates speaker-to-mic acoustic coupling entirely.
   The single most effective fix on developer hardware.
2. **Override `turnDetection` per session** if you need to tune further.
   Useful overrides:
   - `eagerness: 'low'` is already the default; the framework ships it.
     Setting it explicitly documents intent.
   - For environments with persistent echo, `server_vad` with a high
     `threshold` (e.g. `0.8`) and longer `prefix_padding_ms` /
     `silence_duration_ms` may be more predictable than semantic VAD.

   ```ts
   new OpenAIRealtimeTransport({
     // ...
     turnDetection: {
       type: 'server_vad',
       threshold: 0.8,
       prefix_padding_ms: 300,
       silence_duration_ms: 500,
     },
   });
   ```

3. **Tighten the client-VAD echo floor** in `VoiceSessionConfig.clientAudioVad`
   if you also see client-VAD-driven false barge-ins (peak in the 1800–2200
   range). The framework's defaults (`peak: 2000`, `avgAbs: 450`) are
   calibrated for a typical headphones setup; raise them for speaker-playback
   environments.

   ```ts
   new VoiceSession({
     // ...
     clientAudioVad: {
       bargeInTtsPeakThreshold: 3000,
       bargeInTtsAvgAbsThreshold: 700,
     },
   });
   ```

4. **Opt back into provider-owned interruption** (`interrupt_response: true`)
   if you accept the loss of the greeting-grace protection. OpenAI's
   server-side cancel is sometimes more robust against semantic edge cases at
   the cost of less framework control. The framework downgrades
   `greetingInterruptGraceMs` to `0` automatically in this mode with a
   warning log.

### Related

- [Playback Gate](/guide/playback-gate) — how the framework keeps a turn
  open until the client actually finishes playing.
- [Transport](/guide/transport) — provider abstractions and capabilities.
