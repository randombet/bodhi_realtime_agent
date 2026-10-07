/** Default timeout for individual tool executions (ms). */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Default timeout for memory extraction via AI (ms). */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000;

/** Default timeout for Gemini Live API connect/setupComplete (ms). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Default force-kill delay for a transport reconnect (ms). When it expires the
 *  transport clears its session field; it does not bound the incumbent's close
 *  or the redial. */
export const DEFAULT_RECONNECT_TIMEOUT_MS = 45_000;

/** Session-level deadline for one automatic reconnect attempt (ms). Past it the
 *  reconnector abandons the attempt and closes the session with
 *  `reconnect_failed`, so a reconnect whose dial or setup never settles cannot
 *  leave the session in RECONNECTING. Shorter than, and distinct from, the
 *  transport's own {@link DEFAULT_RECONNECT_TIMEOUT_MS} force-kill. Internal: the
 *  public contract is `VoiceSession.RECONNECT_DEADLINE_MS`. */
export const DEFAULT_RECONNECT_DEADLINE_MS = 30_000;

/** Default model-silence watchdog after the user's turn ends (ms). A silent
 *  stall (socket open, no model output) past this forces a reconnect.
 *  `<= 0` disables the watchdog. Lowered from 8_000 to recover stalls faster;
 *  must stay above worst-case legitimate first-token latency (observed:
 *  ~1.3–2.8 s normal, ~2.2 s grounded on gemini-3.1-flash-live-preview —
 *  but ~6 s grounded on the older native-audio model). */
export const DEFAULT_RESPONSE_WATCHDOG_MS = 5_000;

/** Max age of a retained user utterance eligible for watchdog-stall recovery
 *  replay (ms) — never replay stale speech. */
export const DEFAULT_REPLAY_MAX_AGE_MS = 30_000;

/** Default timeout for subagent execution (ms). */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 60_000;
