import 'dotenv/config';
import { createServer } from 'node:http';

const HTTP_PORT = Number(process.env.CLIENT_PORT) || 8080;
const HTTP_HOST = process.env.CLIENT_HOST || '0.0.0.0';
const WS_PORT = Number(process.env.PORT) || 9900;
const TOKEN_SERVER_URL = process.env.SPATIALREAL_TOKEN_SERVER_URL || 'http://localhost:9901';
const SPATIALREAL_APP_ID = process.env.SPATIALREAL_APP_ID ?? '';
const SPATIALREAL_AVATAR_ID = process.env.SPATIALREAL_AVATAR_ID ?? '';
const SPATIALREAL_ENV = process.env.SPATIALREAL_ENV === 'cn' ? 'cn' : 'intl';

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Bodhi SpatialReal Host Demo</title>
<style>
body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#0b1020; color:#e5e7eb; display:flex; height:100vh; }
#avatar { flex: 1; position:relative; background:#050814; }
#avatar-container { width:100%; height:100%; }
#panel { width: 420px; border-left:1px solid #1f2937; display:flex; flex-direction:column; background:#111827; }
#top { padding:12px; border-bottom:1px solid #1f2937; display:flex; gap:8px; align-items:center; }
#btn { padding:8px 12px; border-radius:8px; border:1px solid #374151; background:#1f2937; color:white; cursor:pointer; }
#wsUrl { flex:1; border:1px solid #374151; border-radius:8px; background:#0b1220; color:#fff; padding:8px; }
#status { font-size:12px; color:#9ca3af; }
#transcript { flex:1; overflow:auto; padding:12px; font-size:14px; line-height:1.5; }
.u { color:#93c5fd; margin:6px 0; }
.a { color:#86efac; margin:6px 0; }
.s { color:#9ca3af; font-size:12px; margin:6px 0; }
</style>
</head>
<body>
  <div id="avatar"><div id="avatar-container"></div></div>
  <div id="panel">
    <div id="top">
      <input id="wsUrl" value="ws://localhost:${WS_PORT}" />
      <button id="btn">Connect</button>
    </div>
    <div style="padding:8px 12px;border-bottom:1px solid #1f2937;"><div id="status">Disconnected</div></div>
    <div id="transcript"><div class="s">Press Connect, allow microphone access, and start speaking.</div></div>
  </div>
<script type="module">
import {
  AvatarSDK,
  AvatarManager,
  AvatarView,
  Environment,
  DrivingServiceMode,
  LogLevel,
} from "https://esm.sh/@spatialwalk/avatarkit";

const CONFIG = {
  tokenServerUrl: ${JSON.stringify(TOKEN_SERVER_URL)},
  appId: ${JSON.stringify(SPATIALREAL_APP_ID)},
  avatarId: ${JSON.stringify(SPATIALREAL_AVATAR_ID)},
  env: ${JSON.stringify(SPATIALREAL_ENV)},
};

const $ = (id) => document.getElementById(id);
const status = (msg) => { $("status").textContent = msg; };
const log = (cls, msg) => {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = msg;
  $("transcript").appendChild(el);
  $("transcript").scrollTop = $("transcript").scrollHeight;
};

let connected = false;
let ws = null;
let audioCtx = null;
let mic = null;
let proc = null;
let avatarView = null;
let inputRate = 16000;
let currentUserEl = null;
let currentAssistantEl = null;
let outputRate = 24000;
let sendCount = 0;

function downsample(input, from, to) {
  if (from === to) return input;
  const ratio = from / to;
  const len = Math.floor(input.length / ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    out[i] = input[idx] * (1 - frac) + (input[idx + 1] || 0) * frac;
  }
  return out;
}
function float32ToInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
  }
  return out;
}

function handleTranscript(role, text, partial) {
  if (role === "user") {
    if (partial) {
      if (!currentUserEl) {
        currentUserEl = document.createElement("div");
        currentUserEl.className = "u";
        $("transcript").appendChild(currentUserEl);
      }
      currentUserEl.textContent = "You: " + text;
    } else {
      if (!currentUserEl) {
        currentUserEl = document.createElement("div");
        currentUserEl.className = "u";
        $("transcript").appendChild(currentUserEl);
      }
      currentUserEl.textContent = "You: " + text;
      currentUserEl = null;
    }
  } else {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement("div");
      currentAssistantEl.className = "a";
      $("transcript").appendChild(currentAssistantEl);
    }
    currentAssistantEl.textContent = "Bodhi: " + text;
    if (!partial) currentAssistantEl = null;
  }
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

const DRIP_INTERVAL_MS = 10;
const DRIP_AUDIO_MS = 100;
const PREBUFFER_MS = 1000;

let audioQueue = [];
let audioQueueBytes = 0;
let dripTimer = null;
let dripStarted = false;
let pendingLast = false;

function enqueueAudio(pcmData, isLast) {
  if (isLast) {
    pendingLast = true;
    if (audioQueueBytes === 0 && dripStarted) flushLast();
    return;
  }
  if (!(pcmData instanceof ArrayBuffer) || pcmData.byteLength === 0) return;
  const chunk = new Uint8Array(pcmData);
  audioQueue.push(chunk);
  audioQueueBytes += chunk.byteLength;

  const prebufferBytes = Math.round(outputRate * (PREBUFFER_MS / 1000) * 2);
  if (!dripStarted && audioQueueBytes >= prebufferBytes) startDrip();
}

function startDrip() {
  if (dripTimer) return;
  dripStarted = true;
  dripTimer = setInterval(dripTick, DRIP_INTERVAL_MS);
}

function dripTick() {
  if (!avatarView) return;
  const dripBytes = Math.round(outputRate * (DRIP_AUDIO_MS / 1000) * 2);
  let toSend = dripBytes;
  const parts = [];
  while (toSend > 0 && audioQueue.length > 0) {
    const front = audioQueue[0];
    if (front.length <= toSend) {
      parts.push(front);
      toSend -= front.length;
      audioQueueBytes -= front.length;
      audioQueue.shift();
    } else {
      parts.push(front.slice(0, toSend));
      audioQueue[0] = front.slice(toSend);
      audioQueueBytes -= toSend;
      toSend = 0;
    }
  }

  if (parts.length > 0) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { merged.set(p, off); off += p.length; }
    try {
      avatarView.controller.yieldAudioData(merged, false);
      sendCount++;
    } catch (e) {
      log("s", "[avatar] yieldAudioData error: " + e.message);
    }
  }

  if (audioQueueBytes === 0 && pendingLast) flushLast();
}

function flushLast() {
  if (!avatarView) return;
  stopDrip();
  try {
    avatarView.controller.yieldAudioData(new Uint8Array(0), true);
  } catch (e) {
    log("s", "[avatar] yieldAudioData(last) error: " + e.message);
  }
  pendingLast = false;
}

function stopDrip() {
  if (dripTimer) { clearInterval(dripTimer); dripTimer = null; }
  dripStarted = false;
  audioQueue = [];
  audioQueueBytes = 0;
  pendingLast = false;
}

function sendFramesToAvatar(framesBase64) {
  if (!avatarView) return;
  const convId = avatarView.controller.getCurrentConversationId();
  if (!convId) return;
  try {
    const buffers = framesBase64.map((b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    });
    avatarView.controller.yieldFramesData(buffers, convId);
  } catch (e) {
    log("s", "[avatar] yieldFramesData error: " + e.message);
  }
}

async function initAvatar() {
  if (!CONFIG.appId || !CONFIG.avatarId) throw new Error("Missing SPATIALREAL_APP_ID or SPATIALREAL_AVATAR_ID");
  await AvatarSDK.initialize(CONFIG.appId, {
    environment: CONFIG.env === "cn" ? Environment.cn : Environment.intl,
    drivingServiceMode: DrivingServiceMode.host,
    logLevel: LogLevel.warning,
    audioFormat: { channelCount: 1, sampleRate: outputRate },
  });

  const avatar = await AvatarManager.shared.load(CONFIG.avatarId);
  if (!avatar) throw new Error("Failed to load avatar");
  avatarView = new AvatarView(avatar, $("avatar-container"));

  const tokenResp = await fetch(CONFIG.tokenServerUrl + "/api/token", { method: "POST" });
  if (!tokenResp.ok) throw new Error("Missing/invalid SpatialReal session token");
  const tokenData = await tokenResp.json();
  AvatarSDK.setSessionToken(tokenData.sessionToken);
  await avatarView.controller.initializeAudioContext();
  avatarView.controller.onConversationState = (state) => {
    log("s", "[avatar] state: " + state);
  };
  avatarView.controller.onError = (err) => {
    log("s", "[avatar] error: " + err.message);
  };
  log("s", "Avatar ready (host mode).");
}

async function startMic() {
  mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  if (!audioCtx || audioCtx.state === "closed") audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const source = audioCtx.createMediaStreamSource(mic);
  proc = audioCtx.createScriptProcessor(2048, 1, 1);
  proc.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const raw = e.inputBuffer.getChannelData(0);
    const down = downsample(raw, audioCtx.sampleRate, inputRate);
    const pcm = float32ToInt16(down);
    ws.send(pcm.buffer);
  };
  source.connect(proc);
  const g = audioCtx.createGain(); g.gain.value = 0;
  proc.connect(g); g.connect(audioCtx.destination);
}

function stopMic() {
  if (proc) { proc.disconnect(); proc = null; }
  if (mic) { mic.getTracks().forEach((t) => t.stop()); mic = null; }
}

function connectWs() {
  const url = $("wsUrl").value.trim();
  ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = async () => {
    status("Connected");
    await startMic();
    log("a", "Connected. You should hear Bodhi greeting shortly.");
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      enqueueAudio(event.data, false);
      return;
    }
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "session.config" && msg.audioFormat) {
        inputRate = Number(msg.audioFormat.inputSampleRate) || inputRate;
        outputRate = Number(msg.audioFormat.outputSampleRate) || outputRate;
      } else if (msg.type === "transcript") {
        handleTranscript(msg.role, msg.text, msg.partial !== false);
      } else if (msg.type === "avatar.keyframes") {
        sendFramesToAvatar(msg.frames || []);
      } else if (msg.type === "turn.end") {
        enqueueAudio(new ArrayBuffer(0), true);
        currentAssistantEl = null;
        currentUserEl = null;
      } else if (msg.type === "turn.interrupted") {
        stopDrip();
        try { avatarView?.controller.interrupt(); } catch {}
      } else if (msg.type === "session_end") {
        log("s", "Session ended.");
        ws?.close();
      }
    } catch {}
  };

  ws.onclose = () => {
    stopMic();
    stopDrip();
    status("Disconnected");
    connected = false;
    $("btn").textContent = "Connect";
  };

  ws.onerror = () => {
    status("Connection failed");
    log("s", "WebSocket error. Is demo.ts running?");
  };
}

async function toggle() {
  if (connected) {
    stopMic();
    stopDrip();
    ws?.close();
    connected = false;
    $("btn").textContent = "Connect";
    status("Disconnected");
    log("s", "Disconnected.");
    return;
  }
  try {
    $("btn").disabled = true;
    status("Initializing avatar...");
    await initAvatar();
    connectWs();
    connected = true;
    $("btn").textContent = "Disconnect";
    status("Live");
  } catch (err) {
    status("Init failed");
    log("s", String(err));
  } finally {
    $("btn").disabled = false;
  }
}

$("btn").addEventListener("click", () => toggle());
</script>
</body>
</html>`;

const server = createServer((req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	res.end(HTML);
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
	const url =
		HTTP_HOST === '0.0.0.0'
			? `http://localhost:${HTTP_PORT} (or your server IP)`
			: `http://${HTTP_HOST}:${HTTP_PORT}`;
	console.log(`SpatialReal demo web client: ${url}`);
	console.log(`Voice backend ws default: ws://localhost:${WS_PORT}`);
	console.log(`SpatialReal token backend: ${TOKEN_SERVER_URL}`);
});
