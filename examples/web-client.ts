/**
 * Web Audio Client for Bodhi Voice Agent
 *
 * Usage:
 *   1. Start the voice agent:  pnpm tsx app/gemini-realtime-tools.ts
 *   2. Start this client:      pnpm tsx app/web-client.ts
 *   3. Open http://localhost:8080 in your browser
 *   4. Click "Connect" and allow microphone access
 */

import { createServer } from 'node:http';

const HTTP_PORT = Number(process.env.CLIENT_PORT) || 8080;
const HTTP_HOST = process.env.CLIENT_HOST || '0.0.0.0'; // '0.0.0.0' binds to all interfaces for EC2
const WS_PORT = Number(process.env.PORT) || 9900;
const DEFAULT_WS_URL = `ws://localhost:${WS_PORT}`;

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
  .t-interim { color: #64b5f6; opacity: 0.6; font-size: 13px; }
  .t-interim::before { content: 'You: '; font-weight: 600; }
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
  .input-row {
    width: 100%; max-width: 700px;
    display: flex; gap: 8px; margin-bottom: 12px;
  }
  .input-row input[type=text] {
    flex: 1; padding: 9px 12px; border-radius: 8px;
    border: 1px solid #333; background: #12122a; color: #fff; font-size: 13px;
    outline: none;
  }
  .input-row input:focus { border-color: #4a6fa5; }
  .btn-upload {
    padding: 9px 12px; border-radius: 8px; border: none;
    background: #2a2a4e; color: #aaa; font-size: 16px; cursor: pointer;
  }
  .btn-upload:hover { background: #3a3a5e; color: #fff; }
  .btn-send { background: #1e3a5f; color: #fff; }
  .btn-send:hover { background: #2a4a6f; }
  .btn-download {
    display: inline-block; margin-top: 6px; padding: 4px 10px;
    border-radius: 6px; border: 1px solid #444; background: #1a1a2e;
    color: #aaa; font-size: 11px; cursor: pointer; text-decoration: none;
  }
  .btn-download:hover { background: #2a2a4e; color: #fff; }
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

<div class="input-row">
  <input type="text" id="textInput" placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendText()" />
  <button class="btn-send" onclick="sendText()">Send</button>
  <button class="btn-upload" onclick="$('fileInput').click()" title="Upload file">&#x1F4CE;</button>
  <input type="file" id="fileInput" accept="image/png,image/jpeg,image/webp,image/gif,application/pdf" style="display:none" onchange="uploadFile(this)" />
</div>

<div class="pane-label">Debug Log</div>
<div id="debug"></div>

<script>
// ─── Config ───────────────────────────────────────────────
let INPUT_RATE  = 16000;
let OUTPUT_RATE = 24000;
const CAPTURE_BUF = 2048;
const WS_PORT = ${WS_PORT};

// Auto-detect WebSocket URL from current hostname
function getDefaultWsUrl() {
  const hostname = window.location.hostname;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // If HTTPS, use /ws path through nginx proxy; otherwise direct port
  if (window.location.protocol === 'https:') {
    return protocol + '//' + hostname + '/ws';
  }
  return protocol + '//' + hostname + ':' + WS_PORT;
}

// Set default WebSocket URL on page load + init Chrome STT
window.addEventListener('DOMContentLoaded', () => {
  const wsUrlInput = $('wsUrl');
  if (wsUrlInput && !wsUrlInput.value) {
    wsUrlInput.value = getDefaultWsUrl();
  }
  initChromeStt();
});

// ─── State ────────────────────────────────────────────────
let ws = null;
let audioCtx = null;
let micStream = null;
let processor = null;
let connected = false;
let nextPlayTime = 0;
let activeSources = [];
let playbackRate = 1.0;
let bytesSent = 0;
let bytesRecv = 0;
let audioChunksRecv = 0;
let playChunkCount = 0;
let statsTimer = null;

// Chrome STT state — provides real-time interim display; server STT replaces with final
let recognition = null;

const debugLog = [];
const $ = (id) => document.getElementById(id);

// ─── Chrome STT (real-time interim display) ───────────────
function initChromeStt() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    dbg('Browser does not support SpeechRecognition — no interim transcripts available', 'warn');
    return;
  }
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      interim += event.results[i][0].transcript;
    }
    if (interim) showChromeSttInterim(interim);
  };

  recognition.onerror = (event) => {
    if (event.error !== 'no-speech') dbg('Chrome STT error: ' + event.error, 'warn');
  };

  recognition.onend = () => {
    if (connected) {
      try { recognition.start(); } catch {}
    }
  };
}

function showChromeSttInterim(text) {
  if (serverUserTextReceived) return;  // server text is authoritative — don't overwrite
  if (!currentUserEl) {
    currentUserEl = document.createElement('div');
    currentUserEl.className = 't-entry t-interim';
    $('transcript').appendChild(currentUserEl);
  }
  currentUserEl.textContent = text;
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

function startChromeStt() {
  if (!recognition) return;
  try { recognition.start(); } catch {}
}

function stopChromeStt() {
  if (recognition) { try { recognition.stop(); } catch {} }
}

// ─── Transcript ───────────────────────────────────────────
let currentUserEl = null;
let currentAssistantEl = null;
let serverUserTextReceived = false;  // blocks Chrome STT overwrites after server sends

function handleTranscript(role, text, partial) {
  if (role === 'user') {
    dbg('[Server STT] ' + (partial ? 'partial' : 'FINAL') + ': ' + text);
    serverUserTextReceived = true;
    if (partial) {
      if (!currentUserEl) {
        currentUserEl = document.createElement('div');
        currentUserEl.className = 't-entry t-interim';
        $('transcript').appendChild(currentUserEl);
      }
      currentUserEl.textContent = text;
    } else {
      // Final transcript — update in-place for correct ordering
      if (!currentUserEl) {
        currentUserEl = document.createElement('div');
        $('transcript').appendChild(currentUserEl);
      }
      currentUserEl.className = 't-entry t-user';
      currentUserEl.textContent = text;
      currentUserEl = null;
    }
  } else {
    if (!currentAssistantEl) {
      currentAssistantEl = document.createElement('div');
      currentAssistantEl.className = 't-entry t-assistant';
      $('transcript').appendChild(currentAssistantEl);
    }
    currentAssistantEl.textContent = text;
    if (!partial) currentAssistantEl = null;
  }
  $('transcript').scrollTop = $('transcript').scrollHeight;
}

function addSystem(text) {
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
    src.playbackRate.value = playbackRate;
    src.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (nextPlayTime < now) {
      nextPlayTime = now + 0.05;
    }
    src.start(nextPlayTime);
    nextPlayTime += audioBuf.duration / playbackRate;
    activeSources.push(src);
    src.onended = () => {
      const idx = activeSources.indexOf(src);
      if (idx >= 0) activeSources.splice(idx, 1);
    };
    playChunkCount++;

    if (playChunkCount <= 5) {
      dbg('Played chunk #' + playChunkCount + ': ' + f32.length + ' samples, scheduled at ' + nextPlayTime.toFixed(3) + 's (ctx.state=' + audioCtx.state + ')', 'audio');
    }
  } catch (err) {
    dbg('playChunk error: ' + err.message, 'err');
  }
}

// ─── Microphone capture ───────────────────────────────────
async function startMic() {
  // Check if getUserMedia is available (requires HTTPS or localhost)
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    const isLocalhost = window.location.hostname === 'localhost' || 
                       window.location.hostname === '127.0.0.1' ||
                       window.location.hostname === '[::1]';
    const isHttps = window.location.protocol === 'https:';
    
    if (!isLocalhost && !isHttps) {
      throw new Error('Microphone access requires HTTPS. Please access this page via HTTPS (https://your-domain.com) or use localhost. Modern browsers block getUserMedia on HTTP for security.');
    } else {
      throw new Error('Microphone access is not available in this browser. Please use a modern browser that supports getUserMedia.');
    }
  }

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

  // Start Chrome STT for real-time interim display (server final replaces)
  startChromeStt();
}

function stopMic() {
  stopChromeStt();
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

        if (msg.type === 'session.config' && msg.audioFormat) {
          INPUT_RATE = msg.audioFormat.inputSampleRate;
          OUTPUT_RATE = msg.audioFormat.outputSampleRate;
          dbg('Audio format configured: input=' + INPUT_RATE + 'Hz output=' + OUTPUT_RATE + 'Hz', 'event');
        } else if (msg.type === 'transcript') {
          handleTranscript(msg.role, msg.text, msg.partial !== false);
        } else if (msg.type === 'turn.end') {
          // Remove orphaned Chrome STT interim — if server never finalized it,
          // it's echo from the assistant's voice picked up by mic.
          if (currentUserEl && currentUserEl.classList.contains('t-interim')) {
            currentUserEl.remove();
          }
          currentUserEl = null;
          currentAssistantEl = null;
          serverUserTextReceived = false;
        } else if (msg.type === 'turn.interrupted') {
          for (const s of activeSources) {
            try { s.stop(); } catch {}
          }
          activeSources = [];
          nextPlayTime = 0;
          if (currentUserEl && currentUserEl.classList.contains('t-interim')) {
            currentUserEl.remove();
          }
          currentUserEl = null;
          currentAssistantEl = null;
          serverUserTextReceived = false;
        } else if (msg.type === 'gui.update') {
          const guiData = msg.payload?.data;
          if (guiData?.type === 'image' && guiData.base64) {
            const imgEl = document.createElement('div');
            imgEl.className = 't-entry t-system';
            const img = document.createElement('img');
            const imgDataUrl = 'data:' + (guiData.mimeType || 'image/png') + ';base64,' + guiData.base64;
            img.src = imgDataUrl;
            img.alt = guiData.description || 'Generated image';
            img.style.maxWidth = '100%';
            img.style.borderRadius = '8px';
            img.style.marginTop = '8px';
            imgEl.appendChild(img);
            const dlLink = document.createElement('a');
            dlLink.className = 'btn-download';
            dlLink.href = imgDataUrl;
            const ext = (guiData.mimeType || 'image/png').split('/')[1] || 'png';
            dlLink.download = 'generated-image-' + Date.now() + '.' + ext;
            dlLink.textContent = 'Download image';
            imgEl.appendChild(dlLink);
            $('transcript').appendChild(imgEl);
            $('transcript').scrollTop = $('transcript').scrollHeight;
            dbg('Image received via gui.update: ' + (guiData.description || '').slice(0, 50), 'event');
          } else if (guiData?.type === 'video' && guiData.base64) {
            const vidEl = document.createElement('div');
            vidEl.className = 't-entry t-system';
            const vidDataUrl = 'data:' + (guiData.mimeType || 'video/mp4') + ';base64,' + guiData.base64;
            const video = document.createElement('video');
            video.src = vidDataUrl;
            video.controls = true;
            video.autoplay = true;
            video.muted = true;
            video.style.maxWidth = '100%';
            video.style.borderRadius = '8px';
            video.style.marginTop = '8px';
            if (guiData.description) {
              const caption = document.createElement('div');
              caption.style.fontSize = '12px';
              caption.style.color = '#888';
              caption.style.marginTop = '4px';
              caption.textContent = guiData.description;
              vidEl.appendChild(caption);
            }
            vidEl.appendChild(video);
            const dlLink = document.createElement('a');
            dlLink.className = 'btn-download';
            dlLink.href = vidDataUrl;
            const vidExt = (guiData.mimeType || 'video/mp4').split('/')[1] || 'mp4';
            dlLink.download = 'generated-video-' + Date.now() + '.' + vidExt;
            dlLink.textContent = 'Download video';
            vidEl.appendChild(dlLink);
            $('transcript').appendChild(vidEl);
            $('transcript').scrollTop = $('transcript').scrollHeight;
            dbg('Video received via gui.update: ' + (guiData.description || '').slice(0, 50), 'event');
          } else {
            addSystem('[gui] ' + JSON.stringify(guiData));
          }
        } else if (msg.type === 'gui.notification') {
          addSystem('[notification] ' + (msg.payload?.message || ''));
        } else if (msg.type === 'image') {
          const imgEl = document.createElement('div');
          imgEl.className = 't-entry t-system';
          const img = document.createElement('img');
          const legacyDataUrl = 'data:' + (msg.data.mimeType || 'image/png') + ';base64,' + msg.data.base64;
          img.src = legacyDataUrl;
          img.alt = msg.data.description || 'Generated image';
          img.style.maxWidth = '100%';
          img.style.borderRadius = '8px';
          img.style.marginTop = '8px';
          imgEl.appendChild(img);
          const dlLink2 = document.createElement('a');
          dlLink2.className = 'btn-download';
          dlLink2.href = legacyDataUrl;
          const ext2 = (msg.data.mimeType || 'image/png').split('/')[1] || 'png';
          dlLink2.download = 'generated-image-' + Date.now() + '.' + ext2;
          dlLink2.textContent = 'Download image';
          imgEl.appendChild(dlLink2);
          $('transcript').appendChild(imgEl);
          $('transcript').scrollTop = $('transcript').scrollHeight;
          dbg('Image received: ' + (msg.data.description || '').slice(0, 50), 'event');
        } else if (msg.type === 'speech_speed') {
          const speeds = { slow: 0.85, normal: 1.0, fast: 1.2 };
          playbackRate = speeds[msg.speed] || 1.0;
          addSystem('[speed] Speech speed set to ' + msg.speed + ' (' + playbackRate + 'x)');
        } else if (msg.type === 'grounding') {
          const chunks = msg.payload?.groundingChunks;
          if (Array.isArray(chunks) && chunks.length > 0) {
            const sources = chunks.map(c => c.web?.title || c.web?.uri || '').filter(Boolean).join(', ');
            if (sources) addSystem('[sources] ' + sources);
          }
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

// ─── Text input ──────────────────────────────────────────
function sendText() {
  const input = $('textInput');
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({ type: 'text_input', text }));
  input.value = '';

  // Show typed text in the conversation
  currentUserEl = null; // finalize any in-progress user speech
  const el = document.createElement('div');
  el.className = 't-entry t-user';
  el.textContent = text;
  $('transcript').appendChild(el);
  $('transcript').scrollTop = $('transcript').scrollHeight;

  dbg('Sent text: "' + text.slice(0, 50) + '"', 'event');
}

// ─── File upload ─────────────────────────────────────────
function uploadFile(input) {
  const file = input.files?.[0];
  if (!file || !ws || ws.readyState !== WebSocket.OPEN) return;

  if (file.size > 20 * 1024 * 1024) {
    addSystem('File too large (max 20MB)');
    input.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    const [header, base64] = dataUrl.split(',');
    const mimeType = header.match(/:(.*?);/)?.[1] || file.type;

    ws.send(JSON.stringify({
      type: 'file_upload',
      data: { base64, mimeType, fileName: file.name }
    }));

    // Show thumbnail preview
    if (mimeType.startsWith('image/')) {
      const imgEl = document.createElement('div');
      imgEl.className = 't-entry t-system';
      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = file.name;
      img.style.maxWidth = '200px';
      img.style.borderRadius = '8px';
      img.style.marginTop = '4px';
      imgEl.textContent = 'Uploaded: ' + file.name + ' ';
      imgEl.appendChild(img);
      $('transcript').appendChild(imgEl);
    } else {
      addSystem('Uploaded: ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)');
    }

    dbg('Uploaded file: ' + file.name + ' (' + mimeType + ', ' + base64.length + ' chars)', 'event');
    $('transcript').scrollTop = $('transcript').scrollHeight;
  };

  reader.readAsDataURL(file);
  input.value = '';
}
</script>
</body>
</html>`;

const server = createServer((_req, res) => {
	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
	res.end(HTML);
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
	const serverUrl = HTTP_HOST === '0.0.0.0' 
		? `http://localhost:${HTTP_PORT} (or use your server's IP/DNS)`
		: `http://${HTTP_HOST}:${HTTP_PORT}`;
	console.log(`\n  Bodhi Voice Agent — Web Client`);
	console.log(`  ────────────────────────────────`);
	console.log(`  Open in browser:  ${serverUrl}`);
	console.log(`  WebSocket URL:    Auto-detected from browser hostname`);
	console.log(`  WebSocket port:  ${WS_PORT}`);
	console.log(`\n  Press Ctrl+C to stop.\n`);
});
