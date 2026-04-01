# Twilio Human Transfer Demo

Transfer a live voice AI conversation to a real human on the phone, then return to the AI when the human hangs up.

## How It Works

```
User (browser) ←→ Bodhi AI Agent ←→ Gemini Live API
                        │
          "transfer me to a human"
                        │
                        ▼
User (browser) ←→ TwilioBridge ←→ Twilio ←→ Human (phone)
                        │
                  human hangs up
                        │
                        ▼
User (browser) ←→ Bodhi AI Agent ←→ Gemini Live API (context preserved)
```

- During the human segment, Gemini is **disconnected** (no LLM cost, no latency, full privacy)
- Audio is converted between PCM 16kHz (framework) and mulaw 8kHz (Twilio) automatically
- When the human hangs up, Gemini reconnects with the full conversation context via session resumption

## Prerequisites

1. **Twilio account** — free trial works (with verified caller IDs)
2. **ngrok** — tunneling tool so Twilio can reach your local machine
3. **Gemini API key**

## Setup

### 1. Create a Twilio Account

1. Sign up at https://www.twilio.com/try-twilio (free trial includes $15 credit)
2. After signup, go to the **Console Dashboard**: https://console.twilio.com
3. Find your credentials in the **Account Info** panel:
   - **Account SID** — starts with `AC`
   - **Auth Token** — click "Show" to reveal
   - **My Twilio phone number** — starts with `+1` (this is your caller ID)

4. **Verify the human's phone number** (trial accounts only):
   - Go to https://console.twilio.com/us1/develop/phone-numbers/manage/verified
   - Click "Add a new Caller ID"
   - Enter the phone number that will receive the transfer call
   - Complete the verification (you'll get a call or SMS with a code)
   - Trial accounts can only call verified numbers. Upgrade to remove this restriction.

5. **(Optional) Create an API Key** for restricted access:
   - Go to https://console.twilio.com/us1/account/keys-credentials/api-keys
   - Click "Create API Key", choose "Restricted", name it (e.g., `bodhi_dev`)
   - Save the SID (`SK...`) and Secret — you'll need these if using API key auth

### 2. Install ngrok

ngrok creates a public HTTPS URL that tunnels to your local machine. Twilio needs this to:
- Send webhook requests (TwiML for call setup)
- Connect Media Streams WebSocket (bidirectional audio)

```bash
# Install
brew install ngrok          # macOS
# OR: Download from https://ngrok.com/download for other platforms

# Create a free account at https://dashboard.ngrok.com/signup
# Copy your auth token from https://dashboard.ngrok.com/get-started/your-authtoken

# Authenticate
ngrok config add-authtoken YOUR_NGROK_TOKEN
```

### 3. Environment Variables

Add to your `.env` file in the project root:

```bash
# Required — Gemini
GEMINI_API_KEY=your_gemini_api_key

# Required — Twilio credentials (from Console Dashboard → Account Info)
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_FROM_NUMBER=+1xxxxxxxxxx         # Your Twilio phone number (from dashboard)

# Required — Transfer target
HUMAN_AGENT_PHONE=+1xxxxxxxxxx          # Phone number to dial (must be verified on trial)

# Required — Webhook URL (set AFTER starting ngrok in step 4)
TWILIO_WEBHOOK_URL=https://xxxx.ngrok-free.app

# Optional
PORT=9900                               # Voice WebSocket port (default: 9900)
TWILIO_WEBHOOK_PORT=8766                # Twilio webhook port (default: 8766)
```

### 4. Start ngrok

Open a **separate terminal** and run:

```bash
ngrok http 8766
```

You'll see output like:
```
Session Status  online
Forwarding      https://a1b2-203-0-113-42.ngrok-free.app -> http://localhost:8766
```

Copy the `https://...ngrok-free.app` URL and update your `.env`:
```bash
TWILIO_WEBHOOK_URL=https://a1b2-203-0-113-42.ngrok-free.app
```

**Keep ngrok running** in this terminal while testing. The URL changes each time you restart ngrok (unless you have a paid plan with a fixed subdomain).

### 3. Run the Demo

```bash
pnpm tsx app/twilio-demo.ts
```

### 4. Connect the Web Client

Open `app/web-client.ts` in a browser (or any WebSocket audio client) connecting to `ws://localhost:9900`.

### 5. Test

Say: **"Transfer me to a human"**

Expected flow:
1. Gemini calls `transfer_to_agent` tool with `agent_name: "human_agent"`
2. Server logs: `[Hook] Tool called: transfer_to_agent (inline)`
3. Server logs: `[Transfer] main → human_agent`
4. Server logs: `[HumanAgent] Call connected: CA_xxx`
5. Your phone rings at `HUMAN_AGENT_PHONE`
6. Answer the call — you hear the web client user's voice
7. Hang up — AI agent resumes with full conversation context

## Architecture

| Component | File | Purpose |
|-----------|------|---------|
| **Demo entry** | `app/twilio-demo.ts` | VoiceSession config with main + human agents |
| **Human agent** | `app/lib/twilio-human-agent.ts` | `createHumanAgent()` factory with Twilio wiring |
| **TwilioBridge** | `src/telephony/twilio-bridge.ts` | Call lifecycle, audio bridge, status callbacks |
| **Webhook server** | `src/telephony/twilio-webhook-server.ts` | TwiML, Media Streams WS, status callbacks |
| **Audio codec** | `src/telephony/audio-codec.ts` | mulaw 8kHz ↔ PCM L16 16kHz conversion |

### Framework Extensions

- `MainAgent.audioMode: 'external'` — skips LLM transport, agent manages its own audio
- `AgentContext.requestTransfer()` — async transfer-back when human hangs up
- `AgentContext.setExternalAudioHandler()` — routes client mic audio to TwilioBridge
- `AgentContext.sendAudioToClient()` — sends human's voice to the web client

## Troubleshooting

### Gemini says "connecting you" but nothing happens
Gemini is verbally responding instead of calling the tool. The system prompt includes `CRITICAL TOOL CALLING RULES` to force tool invocation. If it still doesn't work, try rephrasing: "I need to speak with a real person right now."

### Phone doesn't ring
- Check `HUMAN_AGENT_PHONE` is in E.164 format (`+1XXXXXXXXXX`)
- Check `TWILIO_FROM_NUMBER` is a verified Twilio number
- Check ngrok is running and `TWILIO_WEBHOOK_URL` matches
- Check Twilio console for call logs: https://console.twilio.com/us1/monitor/logs/calls

### No audio after phone connects
- Verify ngrok tunnel is forwarding port 8766
- Check server logs for `[HumanAgent] Call connected` — if missing, the Media Stream didn't start
- Verify the web client received `session.config` with `outputSampleRate: 16000`

### Transfer back doesn't work after hangup
- Check server logs for `[HumanAgent] Call ended` — if missing, the status callback didn't fire
- Verify `TWILIO_WEBHOOK_URL` is correct in Twilio's call configuration

### "Cannot make calls to unverified numbers" error
- Trial accounts can only call phone numbers you've verified
- Go to https://console.twilio.com/us1/develop/phone-numbers/manage/verified and add the number
- OR upgrade your Twilio account to remove this restriction

### ngrok URL changed
- ngrok generates a new URL each restart (free plan)
- Update `TWILIO_WEBHOOK_URL` in `.env` and restart the demo
- For a stable URL, use `ngrok http 8766 --subdomain=your-name` (requires paid plan)

### "Error: TWILIO_WEBHOOK_URL is required"
- Make sure `.env` has `TWILIO_WEBHOOK_URL=https://...` (not empty)
- The URL must be the ngrok HTTPS URL, not `http://localhost:8766`

---

## Inbound Calls — Phone to AI Agent

The **outbound** demo above transfers from AI to a human. The **inbound bridge** does the reverse: a phone caller dials your Twilio number and talks directly to the AI agent.

```
  Outbound (twilio-demo.ts):     Browser user ←→ AI ←→ transfer ←→ Human (phone)
  Inbound  (twilio-inbound-bridge.ts):   Phone caller ──→ Bridge ──→ AI agent
```

### Setup

The inbound bridge reuses the same Twilio account and ngrok setup from the outbound demo. The only additional step is configuring your Twilio phone number's webhook.

#### 1. Configure Twilio Phone Number Webhook

Go to the Twilio Console:

```
Twilio Console → Phone Numbers → Manage → Active Numbers
  → Click your phone number
  → Voice Configuration section:
     "A Call Comes In" → Webhook
     URL: https://xxxx.ngrok-free.app/voice
     Method: HTTP POST
     Status Callback URL: https://xxxx.ngrok-free.app/status
     Status Callback Events: initiated, ringing, answered, completed
```

Replace `xxxx.ngrok-free.app` with your actual ngrok URL.
The status callback is required so the bridge can clear active-call state on terminal statuses even if a media stream never starts.

#### 2. Run the Bridge

```bash
# Terminal 1: Start any agent demo
pnpm tsx app/gemini-realtime-tools.ts

# Terminal 2: Start the inbound bridge
pnpm tsx app/twilio-inbound-bridge.ts

# Terminal 3: Start ngrok (if not already running)
ngrok http 8766
```

#### 3. Call Your Twilio Number

Dial the Twilio phone number from any phone. You'll be connected to the AI agent and can converse naturally.

### Differences from Outbound

| Aspect | Outbound (`twilio-demo.ts`) | Inbound (`twilio-inbound-bridge.ts`) |
|--------|----------------------------|--------------------------------------|
| Direction | AI agent dials human's phone | Phone caller dials Twilio number |
| Browser required | Yes (web client is the user) | No (phone is the user) |
| Framework changes | Yes (external audio agent) | None (standalone bridge) |
| Twilio credentials | Required (makes API calls) | Not required (webhook-only) |
| Session lifecycle | Transfer → human → transfer back | Direct connect → hangup |
| Concurrent calls | One (via VoiceSession) | One (bridge gating) |

### Troubleshooting

**Phone rings but no AI response:** The bridge isn't connecting to VoiceSession. Check bridge logs for `[Agent] Connected to VoiceSession`. Make sure the agent demo is running on port 9900.

**Busy signal when calling:** Another call is already active. The bridge allows one call at a time.

**Call connects but drops immediately:** ngrok may have restarted. Update `TWILIO_WEBHOOK_URL` in `.env` and reconfigure the Twilio number webhook.
