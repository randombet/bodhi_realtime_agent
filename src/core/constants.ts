// SPDX-License-Identifier: MIT

/** Default timeout for individual tool executions (ms). */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Default timeout for memory extraction via AI (ms). */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 30_000;

/** Default timeout for Gemini Live API connect/setupComplete (ms). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/** Default timeout for reconnection (disconnect + connect) (ms). */
export const DEFAULT_RECONNECT_TIMEOUT_MS = 45_000;

/** Default timeout for subagent execution (ms). */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = 60_000;
