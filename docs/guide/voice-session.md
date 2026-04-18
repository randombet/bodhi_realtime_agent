# VoiceSession

`VoiceSession` is the top-level runtime integration point.

It manages:

- live transport connection
- agent/tool orchestration
- turn lifecycle
- subagent execution handoff
- optional memory/history/artifact integration

## Typical setup

```ts
const session = new VoiceSession({
  sessionId: 'session_1',
  userId: 'user_1',
  apiKey: process.env.GEMINI_API_KEY!,
  agents: [mainAgent],
  initialAgent: 'main',
  model: google('gemini-2.5-flash'),
  port: 9900,
  orchestrationMode: 'actor',
});
```

## Related

- [Agents](/guide/agents)
- [Tools](/guide/tools)
- [Transport](/guide/transport)
