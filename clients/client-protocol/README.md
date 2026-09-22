# @bodhi/client-protocol

The client-plane wire contract for bodhi voice sessions: core message unions
(server→client and client→server), the wire shapes they carry (client-media,
`AudioFormatSpec`, `UIPayload`, behavior projections, RTC signaling), runtime
pacing constants, and the module-augmentation registries apps and peers use to
add their own frames.

**Zero dependencies, browser-safe.** No Node built-ins, no framework imports —
enforced by `test/clients/protocol-boundary.test.ts`. Built to `dist/` before
every root build/typecheck (`ensure:client-protocol`); the root `prepare`
script builds it on install.

## Who imports what

- **Framework (`src/`)** — via the re-export door `src/types/client-protocol.ts`
  (plus `client-media.ts` / `rtc-signaling.ts` re-exports). Never deep-import.
- **Apps / peers** — the package name directly. Register extension frames by
  augmenting `ClientProtocolServerExtensions` / `ClientProtocolClientExtensions`
  (see `examples/lib/client-protocol-extensions.ts` for a live example).
- **Browser clients** — the package name; `import type` for shapes, value
  imports only for the pacing constants.

## Change rules

1. **Deprecations:** `SubagentCompletionMessage.status` value `'failed'` is
   deprecated (both emit paths now send `'failure'`); it stays in the union
   for one release for consumers compiled against the historical value.
2. Message shapes mirror the real emit sites (regenerate candidates with
   `node scripts/scan-client-protocol.mjs`). Don't add speculative fields.
