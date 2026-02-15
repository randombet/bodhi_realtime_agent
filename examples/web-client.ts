/**
 * Web Audio Client for Bodhi Voice Agent
 *
 * Usage:
 *   1. Start the voice agent:  pnpm tsx examples/gemini-realtime-tools.ts
 *   2. Start this client:      pnpm tsx examples/web-client.ts
 *   3. Open http://localhost:8080 in Chrome
 *   4. Click "Connect" and allow microphone access
 */

import { createServer } from 'node:http';

const HTTP_PORT = Number(process.env.CLIENT_PORT) || 8080;
const DEFAULT_WS_URL = process.env.WS_URL || 'ws://localhost:9900';

const HTML = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Bodhi Voice Agent</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f0f1a; color: #ccc;
    display: flex; flex-direction: column; align-items: center;
    padding: 24px 16px; min-height: 100vh;
  }
  h1 { color: #fff; font-size: 1.4em; margin-bottom: 4px; }
  .sub { color: #666; font-size: 0.85em; margin-bottom: 20px; }
  .panel {
    width: 100%; max-width: 700px;
    background: #1a1a2e; border-radius: 12px; padding: 16px 20px;
    margin-bottom: 12px;
  }
  .row { display: flex; gap: 8px; align-items: center; }
  input[type=text] {
    flex: 1; padding: 9px 12px; border-radius: 8px;
    border: 1px solid #333; background: #12122a; color: #fff; font-size: 13px;
    outline: none;
  }
  input:focus { border-color: #4a6fa5; }
  button {
    padding: 9px 18px; border-radius: 8px; border: none;
    font-size: 13px; font-weight: 600; cursor: pointer; transition: background 0.15s;
    white-space: nowrap;
  }
  .btn-connect { background: #1e5128; color: #fff; }
  .btn-connect:hover { background: #277334; }
  .btn-disconnect { background: #8b1a1a; color: #fff; }
  .btn-disconnect:hover { background: #a52222; }
  .btn-save { background: #333; color: #aaa; font-size: 12px; padding: 6px 12px; }
  .btn-save:hover { background: #444; color: #fff; }
  .indicator {
    display: flex; align-items: center; gap: 8px;
    font-size: 12px; margin-top: 10px;
  }
  .dot {
    width: 9px; height: 9px; border-radius: 50%;
    background: #333; transition: background 0.3s;
  }
  .dot.live { background: #4ecca3; box-shadow: 0 0 6px #4ecca3; }
  .dot.error { background: #e94560; }
  .stats { font-size: 11px; color: #555; margin-left: auto; }
  .pane-label {
    width: 100%; max-width: 700px;
    font-size: 11px; color: #555; margin-bottom: 6px;
    text-transform: uppercase; letter-spacing: 0.5px;
  }
  #transcript {
    width: 100%; max-width: 700px;
    background: #12122a; border-radius: 12px; padding: 14px 16px;
    max-height: 35vh; overflow-y: auto; font-size: 14px; line-height: 1.8;
    margin-bottom: 12px;
  }
  .t-entry { margin-bottom: 4px; }
  .t-user { color: #64b5f6; }
  .t-user::before { content: 'You: '; font-weight: 600; }
  .t-assistant { color: #a5d6a7; }
  .t-assistant::before { content: 'Agent: '; font-weight: 600; }
  .t-system { color: #888; font-style: italic; font-size: 12px; }
  .t-interim { color: #4a6a9f; opacity: 0.6; font-size: 13px; }
  .t-interim::before { content: 'You (hearing): '; font-weight: 600; }
  #debug {
    width: 100%; max-width: 700px;
    background: #0a0a15; border-radius: 12px; padding: 12px 14px;
    max-height: 25vh; overflow-y: auto; font-size: 11px; line-height: 1.6;
    font-family: 'SF Mono', 'Fira Code', monospace;
  }
  .d-entry { color: #555; }
  .d-entry.warn { color: #f0ad4e; }
  .d-entry.err { color: #ef5350; }
  .d-entry.event { color: #9575cd; }
  .d-entry.audio { color: #4db6ac; }
</style>
</head>
<body>

<h1>Bodhi Voice Agent</h1>
<p class="sub">Real-time voice client for testing</p>

<div class="panel">
  <div class="row">
    <input type="text" id="wsUrl" value="${DEFAULT_WS_URL}" />
    <button id="btn" class="btn-connect" onclick="toggle()">Connect</button>
    <button class="btn-save" onclick="saveDebug()">Save Debug</button>
  </div>
  <div class="indicator">
    <div class="dot" id="dot"></div>
    <span id="status">Disconnected</span>
    <span class="stats" id="stats"></span>
  </div>
</div>

<div class="pane-label">Conversation</div>
<div id="transcript">
  <div class="t-entry t-system">Click Connect to start a conversation.</div>
</div>

<div class="pane-label">Debug Log</div>
<div id="debug"></div>

<script>
// ─── Config ───────────────────────────────────────────────
const INPUT_RATE  = 16000;
const OUTPUT_RATE = 24000;
const CAPTURE_BUF = 2048;

// ─── State ────────────────────────────────────────────────
let ws = null;
let audioCtx = null;
let micStream = null;
let processor = null;
let recognition = null;
let connected = false;
let nextPlayTime = 0;
let bytesSent = 0;
let bytesRecv = 0;
let audioChunksRecv = 0;
let playChunkCount = 0;
let statsTimer = null;

const debugLog = [];
const $ = (id) => document.getElementById(id);

// ─── Transcript ───────────────────────────────────────────
let lastAssistantEl = null;
let lastAssistantText = '';
let interimEl = null; // for live speech-to-text preview

function addTranscript(role, text) {
  removeInterim();
  if (role === 'assistant') {
    if (lastAssistantEl) {
      lastAssistantText += (lastAssistantText.endsWith(' ') || text.startsWith(' ')) ? text : ' ' + text;
      lastAssistantEl.textContent = lastAssistantText;
    } else {
      lastAssistantText = text;
      lastAssistantEl = document.createElement('div');
      lastAssistantEl.className = 't-entry t-assistant';
      lastAssistantEl.textContent = text;
      $('transcript').appendChild(lastAssistantEl);
    }
  } else {
    lastAssistantEl = null;
    lastAssistantText = '';
    const el = document.createElement('div');
    el.className = 't-entry t-user';
    el.textContent = text;
    $('transcript').appendChild(el);
  }
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

function showInterim(text) {
  if (!interimEl) {
    interimEl = document.createElement('div');
    interimEl.className = 't-entry t-interim';
    $('transcript').appendChild(interimEl);
  }
  interimEl.textContent = text;
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

function removeInterim() {
  if (interimEl) { interimEl.remove(); interimEl = null; }
}

function addSystem(text) {
  lastAssistantEl = null;
  lastAssistantText = '';
  removeInterim();
  const el = document.createElement('div');
  el.className = 't-entry t-system';
  el.textContent = text;
  $('transcript').appendChild(el);
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

// ─── Debug log ────────────────────────────────────────────
function dbg(text, cls = '') {
  const ts = new Date().toISOString().slice(11, 23);
  const line = ts + '  ' + text;
  debugLog.push(line);
  const el = document.createElement('div');
  el.className = 'd-entry ' + cls;
  el.textContent = line;
  $('debug').appendChild(el);
  while ($('debug').children.length > 500) $('debug').removeChild($('debug').firstChild);
  $('debug').scrollTop = $('debug').scrollHeight;
}

function setStatus(text, state) {
  $('status').textContent = text;
  $('dot').className = 'dot' + (state === 'live' ? ' live' : state === 'error' ? ' error' : '');
}

function updateStats() {
  $('stats').textContent =
    'Sent ' + fmtBytes(bytesSent) + ' / Recv ' + fmtBytes(bytesRecv) +
    ' (' + audioChunksRecv + ' chunks, ' + playChunkCount + ' played)';
}

function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function saveDebug() {
  const data = {
    timestamp: new Date().toISOString(),
    config: { INPUT_RATE, OUTPUT_RATE, CAPTURE_BUF },
    audioCtxState: audioCtx?.state ?? null,
    audioCtxSampleRate: audioCtx?.sampleRate ?? null,
    bytesSent, bytesRecv, audioChunksRecv, playChunkCount,
    log: debugLog,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'voice-debug-' + Date.now() + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  dbg('Debug data saved');
}

// ─── PCM helpers ──────────────────────────────────────────
function downsample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
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
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7FFF) | 0;
  }
  return i16;
}

function int16ToFloat32(buf) {
  const view = new DataView(buf);
  const len = buf.byteLength / 2;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = view.getInt16(i * 2, true) / 32768;
  }
  return out;
}

// ─── Audio playback (gapless scheduling) ──────────────────
function playChunk(arrayBuf) {
  if (!audioCtx) {
    dbg('playChunk: no audioCtx!', 'err');
    return;
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
    dbg('playChunk: resumed suspended audioCtx');
  }

  const f32 = int16ToFloat32(arrayBuf);
  if (f32.length === 0) return;

  try {
    const audioBuf = audioCtx.createBuffer(1, f32.length, OUTPUT_RATE);
    audioBuf.getChannelData(0).set(f32);

    const src = audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.05;
    }
    src.start(nextPlayTime);
    nextPlayTime += audioBuf.duration;
    playChunkCount++;

    if (playChunkCount <= 5) {
      dbg('Played chunk #' + playChunkCount + ': ' + f32.length + ' samples, scheduled at ' + nextPlayTime.toFixed(3) + 's (ctx.state=' + audioCtx.state + ')', 'audio');
    }
  } catch (err) {
    dbg('playChunk error: ' + err.message, 'err');
  }
}

// ─── Local speech recognition (browser STT) ──────────────
function startSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    dbg('Web Speech API not available in this browser', 'warn');
    addSystem('Speech-to-text not available (use Chrome for live transcription).');
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) {
        addTranscript('user', r[0].transcript.trim());
        dbg('Speech final: "' + r[0].transcript.trim() + '"', 'event');
      } else {
        interim += r[0].transcript;
      }
    }
    if (interim) showInterim(interim);
  };

  recognition.onerror = (event) => {
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      dbg('Speech recognition error: ' + event.error, 'warn');
    }
  };

  recognition.onend = () => {
    // Auto-restart if still connected
    if (connected && recognition) {
      try { recognition.start(); } catch {}
    }
  };

  try {
    recognition.start();
    dbg('Speech recognition started');
  } catch (err) {
    dbg('Failed to start speech recognition: ' + err.message, 'warn');
  }
}

function stopSpeechRecognition() {
  if (recognition) {
    try { recognition.abort(); } catch {}
    recognition = null;
  }
  removeInterim();
}

// ─── Microphone capture ───────────────────────────────────
async function startMic() {
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }
  });

  const trackSettings = micStream.getAudioTracks()[0].getSettings();
  dbg('Mic stream: ' + (trackSettings.sampleRate || '?') + ' Hz, device=' + (trackSettings.deviceId || '?').slice(0, 8));

  // Reuse AudioContext created in toggle() on user gesture
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new AudioContext();
    dbg('Created new AudioContext: ' + audioCtx.sampleRate + ' Hz');
  }
  dbg('AudioContext state=' + audioCtx.state + ' sampleRate=' + audioCtx.sampleRate);

  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
    dbg('AudioContext resumed');
  }

  const source = audioCtx.createMediaStreamSource(micStream);

  processor = audioCtx.createScriptProcessor(CAPTURE_BUF, 1, 1);
  let sendCount = 0;
  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const raw = e.inputBuffer.getChannelData(0);
    const down = downsample(raw, audioCtx.sampleRate, INPUT_RATE);
    const pcm = float32ToInt16(down);
    ws.send(pcm.buffer);
    bytesSent += pcm.buffer.byteLength;
    sendCount++;
    if (sendCount <= 3) {
      dbg('Sent mic #' + sendCount + ': ' + pcm.buffer.byteLength + 'B (' + down.length + ' samples @ ' + INPUT_RATE + 'Hz)', 'audio');
    }
  };

  source.connect(processor);
  const silence = audioCtx.createGain();
  silence.gain.value = 0;
  processor.connect(silence);
  silence.connect(audioCtx.destination);

  dbg('Mic capture started');
  addSystem('Microphone active — speak now.');

  // Start browser speech recognition for local transcription
  startSpeechRecognition();
}

function stopMic() {
  stopSpeechRecognition();
  if (processor) { processor.disconnect(); processor = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  // Don't close audioCtx here — playback may still be draining
}

// ─── WebSocket ────────────────────────────────────────────
function connectWs() {
  const url = $('wsUrl').value.trim();
  if (!url) return;

  dbg('Connecting to ' + url);
  setStatus('Connecting...', '');

  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = async () => {
    dbg('WebSocket connected');
    setStatus('Starting mic...', 'live');
    try {
      await startMic();
      setStatus('Live — speak now', 'live');
      statsTimer = setInterval(updateStats, 500);
    } catch (err) {
      dbg('Mic error: ' + err.message, 'err');
      setStatus('Mic error', 'error');
      addSystem('Microphone access denied. Please allow and retry.');
      ws.close();
    }
  };

  ws.onmessage = (event) => {
    if (event.data instanceof ArrayBuffer) {
      bytesRecv += event.data.byteLength;
      audioChunksRecv++;
      if (audioChunksRecv <= 5) {
        dbg('Recv audio #' + audioChunksRecv + ': ' + event.data.byteLength + 'B', 'audio');
      }
      playChunk(event.data);
    } else {
      try {
        const msg = JSON.parse(event.data);
        dbg('Recv: ' + JSON.stringify(msg), 'event');

        if (msg.type === 'transcript') {
          addTranscript(msg.role, msg.text);
        } else if (msg.type === 'turn.end') {
          lastAssistantEl = null;
          lastAssistantText = '';
        } else if (msg.type === 'gui.update') {
          addSystem('[gui] ' + JSON.stringify(msg.payload?.data));
        } else if (msg.type === 'gui.notification') {
          addSystem('[notification] ' + (msg.payload?.message || ''));
        }
      } catch {
        dbg('Bad JSON text frame', 'warn');
      }
    }
  };

  ws.onclose = (e) => {
    dbg('WS closed: code=' + e.code);
    addSystem('Disconnected from agent.');
    doCleanup();
  };

  ws.onerror = () => {
    dbg('WS error', 'err');
    setStatus('Connection failed', 'error');
    addSystem('Connection error — is the agent server running?');
  };
}

function doCleanup() {
  stopMic();
  if (audioCtx && audioCtx.state !== 'closed') {
    // Let remaining scheduled audio finish, then close
    setTimeout(() => { if (audioCtx) { audioCtx.close(); audioCtx = null; } }, 2000);
  }
  setStatus('Disconnected', '');
  connected = false;
  $('btn').textContent = 'Connect';
  $('btn').className = 'btn-connect';
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  updateStats();
}

// ─── UI toggle (user gesture context!) ────────────────────
function toggle() {
  if (connected) {
    if (ws) { ws.close(); ws = null; }
    doCleanup();
  } else {
    // Create AudioContext HERE in the click handler so browsers allow playback
    audioCtx = new AudioContext();
    dbg('AudioContext created on click: state=' + audioCtx.state + ' sampleRate=' + audioCtx.sampleRate);

    // Reset counters
    nextPlayTime = 0;
    bytesSent = 0;
    bytesRecv = 0;
    audioChunksRecv = 0;
    playChunkCount = 0;

    connected = true;
    $('btn').textContent = 'Disconnect';
    $('btn').className = 'btn-disconnect';
    connectWs();
  }
}
</script>
</body>
</html>`;

const server = createServer((_req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	res.end(HTML);
});

server.listen(HTTP_PORT, () => {
	console.log(`\n  Bodhi Voice Agent — Web Client`);
	console.log(`  ────────────────────────────────`);
	console.log(`  Open in browser:  http://localhost:${HTTP_PORT}`);
	console.log(`  Agent WebSocket:  ${DEFAULT_WS_URL}`);
	console.log(`\n  Press Ctrl+C to stop.\n`);
});
