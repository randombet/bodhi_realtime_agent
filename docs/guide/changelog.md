# Changelog

User-visible changes in each release of `bodhi-realtime-agent`, newest first.
Numbers in parentheses are pull requests.

## 0.5.0

### Changed

- The Gemini Live transport sends an idle keepalive by default. When its
  connection is up and no audio has gone to the model for `keepaliveIntervalMs`
  (default `20000`), it sends 100 ms of silence, so the server does not close
  the session for inactivity, for example in transcription mode or while an app
  holds back mic audio. To turn it off, set `keepaliveIntervalMs: 0` on
  `GeminiTransportOptions`, or on `VoiceSessionConfig` when the session builds
  its own Gemini transport; a transport you pass in is configured directly. This
  changed default is why this
  release is a minor. See [Idle keepalive](./transport#idle-keepalive-gemini-live).
  ([#70])
- `InMemoryPostSessionPipeline`:
  - A throw from `shouldRun()`, or a throw or rejection from `run()`, makes the
    result `failed` and never rejects `run.report`. A thrown non-`Error` value
    reaches `PostSessionResult.error` as an `Error` with the value as its
    `cause`. A thrown `postSessionSkip()` value, or a value that cannot be
    inspected, becomes an `Error` without a `cause`; a thrown skip is reported
    as `failed`, not `skipped`. ([#71])
  - An `onError` handler that throws no longer rejects `run.report` or makes
    `dispatch()` throw. ([#71])
  - Processors start, and `results` are listed, in a stable dependency order in
    which registration order breaks ties. A branched dependency graph may run
    in a different order than before. ([#71])
  - A finite `runBudgetMs` above 2³¹−1 ms is honoured instead of ending the run
    after about 1 ms. ([#72])

### Added

- The post-session API is exported from the package root, so a host can run its
  own work after a session closes: `InMemoryPostSessionPipeline`,
  `PostSessionProcessor`, `postSessionSkip`, `isPostSessionSkip`, and the
  post-session types (`PostSessionPipeline`, `PostSessionContext`,
  `PostSessionResult`, `PostSessionReport`, `PostSessionStores`,
  `PostSessionSkip` and others). See
  [Post-session processing](./voice-session#post-session-processing). ([#71])
- `postSessionSkip(reason, detail?)`, returned from `run()`, reports the
  processor as `skipped` when it finds at run time that it has nothing to do.
  ([#71])
- `RunFailureReason` is open (`| (string & {})`), so a later release can add
  reasons; handle values you do not know. ([#71])
- `PostSessionProcessor.after`, with a required finite `afterWaitMs`: the
  processor waits for the named processors, whatever their outcome, and starts
  when they have all settled or `afterWaitMs` has passed, whichever comes
  first. ([#72])
- `VoiceSessionConfig.postSessionStores` hands per-session values to that
  session's post-session processors through `ctx.stores`. ([#73])
- `ConversationItem.inputTextReceived` (`{ firstAt, lastAt }`, type
  `InputTextReceipt`) tells when the input text of a spoken user item arrived.
  These are receipt times, not speech start or stop. ([#73])

## 0.4.9

### Fixed

- After a reconnect resumes the session, a notification published while the
  resumed turn still owes a BLOCKING function response now waits for that
  response. In 0.4.8 it could go out ahead of it. ([#66])
- Speech during one reconnect window no longer holds back the notification
  drain after later reconnects (GoAway, credential expiry, `recoverUpstream()`):
  each window is judged on its own speech. ([#66])

## 0.4.8

### Changed

- The `@google/genai` dependency moves from `^1.52.0` to `^2.30.0`, a major
  version of the SDK. In 2.x, `live.connect` resolves only after the server's
  `setupComplete`. The Gemini Live transport now holds messages that arrive
  before its session is installed and handles them in order, so sends made when
  the session becomes ready (the greeting, a reconnect's history replay) are no
  longer dropped. ([#62])
- After an automatic reconnect, queued notifications no longer wait on a turn
  the reconnect cut off. Once the new connection is up, the session delivers one
  queued notification when the reconnect started no response, the user is not
  speaking, and no BLOCKING function call is still open on the live connection.
  An open NON_BLOCKING call does not hold it back. ([#61])
- In transcription mode, a tool result with `scheduling: 'silent'` goes out at
  once only where the provider honours it: every tool on OpenAI, Qwen and the
  text transport, and NON_BLOCKING functions on Gemini. Elsewhere it waits for
  agent mode like any other result. ([#61])

### Added

- `speech.user_aborted` event: a `speech.user_started` whose segment will never
  end, because client VAD dropped it as too short or a reset discarded it. No
  `speech.user_ended` follows it. ([#61])
- A persistent subagent instance may implement `invokeWithScheduling` and
  return `{ text, scheduling: 'silent' }` (`PersistentSubagentResult`). For a
  tool without `pendingMessage`, this adds the result to the model's context
  without prompting a response; Gemini honours it for NON_BLOCKING tools. For a
  `pendingMessage` tool, whose call was already answered, the completion is
  recorded in the conversation context but is neither sent to the model nor
  published as a completion notification. Supported on the actor-mode
  persistent path only; `PersistentSubagentManager.invokeWithScheduling` goes
  with it. ([#61])
- `TransportCapabilities.explicitGenerationTrigger`: whether
  `triggerGeneration()` starts a model response by itself. ([#61])

[#61]: https://github.com/randombet/bodhi_realtime_agent/pull/61
[#62]: https://github.com/randombet/bodhi_realtime_agent/pull/62
[#66]: https://github.com/randombet/bodhi_realtime_agent/pull/66
[#70]: https://github.com/randombet/bodhi_realtime_agent/pull/70
[#71]: https://github.com/randombet/bodhi_realtime_agent/pull/71
[#72]: https://github.com/randombet/bodhi_realtime_agent/pull/72
[#73]: https://github.com/randombet/bodhi_realtime_agent/pull/73
