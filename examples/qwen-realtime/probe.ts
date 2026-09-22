/**
 * Qwen Omni Realtime — Phase 0 verification spike (design-qwen-realtime-transport.md).
 *
 * Runs probes 0.1–0.9 against the live DashScope endpoint and prints a results
 * table. NOT shipped — a throwaway spike harness to resolve protocol unknowns
 * before implementing the transport.
 *
 *   QWEN_API_KEY (or DASHSCOPE_API_KEY) must be set. Then:
 *     pnpm tsx examples/qwen-realtime/probe.ts
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const API_KEY = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
if (!API_KEY) {
	console.error('QWEN_API_KEY (or DASHSCOPE_API_KEY) required');
	process.exit(1);
}
const BASE =
	process.env.QWEN_REALTIME_URL ?? 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime';
const MODEL = process.env.QWEN_REALTIME_MODEL ?? 'qwen3.5-omni-plus-realtime';
const CHUNK = 3200; // 100ms @ 16k mono s16le

type Ev = { type?: string; [k: string]: unknown };

/** ~1.5s of silence so server VAD detects end-of-speech (speech_stopped). */
const SILENCE = Buffer.alloc(16000 * 2 * 1.5, 0);

function synth(text: string): Buffer | null {
	const aiff = join(tmpdir(), 'qp.aiff');
	const pcm = join(tmpdir(), 'qp.pcm');
	try {
		execFileSync('say', ['-o', aiff, text], { stdio: 'ignore' });
		execFileSync('ffmpeg', ['-y', '-i', aiff, '-ar', '16000', '-ac', '1', '-f', 's16le', pcm], {
			stdio: 'ignore',
		});
		// Append trailing silence so server_vad sees end-of-turn.
		return Buffer.concat([readFileSync(pcm), SILENCE]);
	} catch {
		return null;
	}
}

class Conn {
	ws: WebSocket;
	events: Ev[] = [];
	private cbs: Array<(e: Ev) => void> = [];
	private constructor(ws: WebSocket) {
		this.ws = ws;
		ws.on('message', (raw) => {
			let e: Ev;
			try {
				e = JSON.parse(raw.toString());
			} catch {
				return;
			}
			this.events.push(e);
			for (const cb of this.cbs) cb(e);
		});
	}
	static open(): Promise<Conn> {
		const url = `${BASE}?model=${encodeURIComponent(MODEL)}`;
		const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
		return new Promise((resolve, reject) => {
			ws.on('open', () => resolve(new Conn(ws)));
			ws.on('error', (e) => reject(e));
		});
	}
	send(msg: Record<string, unknown>): void {
		this.ws.send(JSON.stringify(msg));
	}
	/** Resolve with the first event matching pred, or null after timeoutMs. */
	waitFor(pred: (e: Ev) => boolean, timeoutMs: number): Promise<Ev | null> {
		const existing = this.events.find(pred);
		if (existing) return Promise.resolve(existing);
		return new Promise((resolve) => {
			const t = setTimeout(() => resolve(null), timeoutMs);
			this.cbs.push((e) => {
				if (pred(e)) {
					clearTimeout(t);
					resolve(e);
				}
			});
		});
	}
	streamAudio(pcm: Buffer): void {
		for (let i = 0; i < pcm.length; i += CHUNK) {
			this.send({
				type: 'input_audio_buffer.append',
				audio: pcm.subarray(i, i + CHUNK).toString('base64'),
			});
		}
	}
	async sessionUpdate(session: Record<string, unknown>, timeoutMs = 5000): Promise<Ev | null> {
		this.send({ type: 'session.update', session });
		return this.waitFor((e) => e.type === 'session.updated' || e.type === 'error', timeoutMs);
	}
	close(): void {
		try {
			this.ws.close();
		} catch {
			/* */
		}
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ probe: string; result: string; detail: string }> = [];
function record(probe: string, result: string, detail = ''): void {
	results.push({ probe, result, detail });
	console.log(`\n[${probe}] ${result} ${detail}`);
}
function errText(e: Ev | null): string {
	if (!e) return '(timeout/no-response)';
	if (e.type === 'error') return `error: ${JSON.stringify((e as { error?: unknown }).error ?? e)}`;
	return e.type ?? '?';
}

const SERVER_VAD = { type: 'server_vad' };

async function probe01_serverVad(general: Buffer | null) {
	if (!general) {
		record('0.1 server_vad', 'SKIP', 'no audio tooling');
		return false;
	}
	// Variant A: plain server_vad. Variant B: server_vad with create_response:true.
	for (const [label, td] of [
		['default', SERVER_VAD],
		['create_response:true', { type: 'server_vad', create_response: true }],
	] as const) {
		const c = await Conn.open();
		await c.sessionUpdate({
			modalities: ['text', 'audio'],
			input_audio_format: 'pcm',
			output_audio_format: 'pcm',
			turn_detection: td,
		});
		c.streamAudio(general);
		const started = await c.waitFor((e) => e.type === 'input_audio_buffer.speech_started', 8000);
		const stopped = await c.waitFor((e) => e.type === 'input_audio_buffer.speech_stopped', 8000);
		const created = await c.waitFor((e) => e.type === 'response.created', 12000);
		const audio = await c.waitFor((e) => e.type === 'response.audio.delta', 12000);
		c.close();
		if (created) {
			record(
				'0.1 server_vad',
				'PASS',
				`[${label}] speech_started=${!!started} speech_stopped=${!!stopped} response.created=true audio=${!!audio}`,
			);
			return true;
		}
		record(
			'0.1 server_vad',
			'try',
			`[${label}] speech_started=${!!started} speech_stopped=${!!stopped} response.created=false`,
		);
		await sleep(200);
	}
	record('0.1 server_vad', 'FAIL', 'no auto response.created in either variant');
	return false;
}

async function probe02_c6(general: Buffer | null) {
	const c = await Conn.open();
	await c.sessionUpdate({ modalities: ['text', 'audio'], turn_detection: SERVER_VAD });
	// Provide a tiny bit of audio context then send an explicit response.create under server_vad.
	if (general) c.streamAudio(general.subarray(0, CHUNK * 5));
	c.send({ type: 'response.create' });
	const r = await c.waitFor((e) => e.type === 'response.created' || e.type === 'error', 8000);
	const ok = r?.type === 'response.created';
	record('0.2 response.create under server_vad (C6)', ok ? 'OK' : 'REJECTED', errText(r));
	c.close();
	return ok;
}

async function probe03_tools(weather: Buffer | null) {
	const c = await Conn.open();
	const tools = [
		{
			type: 'function',
			name: 'get_weather',
			description: 'Get the current weather for a city',
			parameters: {
				type: 'object',
				properties: { city: { type: 'string', description: 'City name' } },
				required: ['city'],
			},
		},
	];
	const upd = await c.sessionUpdate({
		modalities: ['text', 'audio'],
		turn_detection: SERVER_VAD,
		tools,
		tool_choice: 'auto',
	});
	if (upd?.type === 'error') {
		record('0.3 tools (T1)', 'NO', `session.update rejected tools: ${errText(upd)}`);
		c.close();
		return { ok: false };
	}
	if (!weather) {
		record('0.3 tools (T1)', 'SKIP', 'no audio tooling');
		c.close();
		return { ok: false };
	}
	c.streamAudio(weather);
	const fc = await c.waitFor(
		(e) =>
			e.type === 'response.function_call_arguments.delta' ||
			e.type === 'response.function_call_arguments.done' ||
			(e.type === 'response.output_item.added' && JSON.stringify(e).includes('function_call')) ||
			(e.type === 'response.output_item.done' && JSON.stringify(e).includes('function_call')),
		15000,
	);
	const ok = !!fc;
	let followUp = 'n/a';
	if (ok) {
		// Try the function_call_output round-trip + response.create under server_vad.
		const callId =
			(fc as { call_id?: string; item?: { call_id?: string; id?: string } }).call_id ??
			(fc as { item?: { call_id?: string } }).item?.call_id ??
			(fc as { item?: { id?: string } }).item?.id ??
			'unknown';
		c.send({
			type: 'conversation.item.create',
			item: { type: 'function_call_output', call_id: callId, output: '{"tempC":21,"sky":"clear"}' },
		});
		const itemAck = await c.waitFor(
			(e) => e.type === 'conversation.item.created' || e.type === 'error',
			5000,
		);
		c.send({ type: 'response.create' });
		const resp = await c.waitFor((e) => e.type === 'response.created' || e.type === 'error', 6000);
		followUp = `item=${errText(itemAck)} resp=${errText(resp)} callId=${callId} fcEvent=${fc.type}`;
	}
	record('0.3 tools (T1)', ok ? 'YES' : 'NO', `fc=${fc?.type ?? 'none'}; followUp: ${followUp}`);
	c.close();
	return { ok, fcEvent: fc?.type };
}

async function probe04_o1text() {
	const c = await Conn.open();
	// Manual mode so nothing auto-responds; isolate the item-create itself.
	await c.sessionUpdate({ modalities: ['text', 'audio'], turn_detection: null });
	c.send({
		type: 'conversation.item.create',
		item: {
			type: 'message',
			role: 'user',
			content: [{ type: 'input_text', text: 'Say a one word greeting.' }],
		},
	});
	const r = await c.waitFor(
		(e) => e.type === 'conversation.item.created' || e.type === 'error',
		6000,
	);
	const ok = r?.type === 'conversation.item.created';
	record('0.4 text-item injection (O1-text)', ok ? 'YES' : 'NO', errText(r));
	c.close();
	return ok;
}

async function probe06_o3() {
	const c = await Conn.open();
	await c.sessionUpdate({ modalities: ['text', 'audio'], turn_detection: SERVER_VAD });
	const i = await c.sessionUpdate({ instructions: 'You are terse.' });
	const v = await c.sessionUpdate({ voice: 'Tina' });
	const m = await c.sessionUpdate({ modalities: ['text'] });
	const ok =
		i?.type === 'session.updated' && v?.type === 'session.updated' && m?.type === 'session.updated';
	record(
		'0.6 in-place session.update (O3)',
		ok ? 'YES' : 'PARTIAL/NO',
		`instructions=${errText(i)} voice=${errText(v)} modality=${errText(m)}`,
	);
	c.close();
	return ok;
}

async function probe07_o4() {
	const c = await Conn.open();
	await c.sessionUpdate({ modalities: ['text', 'audio'], turn_detection: null });
	c.send({ type: 'response.create', response: { instructions: 'Reply with the single word OK.' } });
	const r = await c.waitFor((e) => e.type === 'response.created' || e.type === 'error', 6000);
	const ok = r?.type === 'response.created';
	record('0.7 response.instructions (O4)', ok ? 'ACCEPTED' : 'REJECTED', errText(r));
	c.close();
	return ok;
}

async function probe08_c5(general: Buffer | null) {
	const c = await Conn.open();
	await c.sessionUpdate({
		modalities: ['text', 'audio'],
		turn_detection: SERVER_VAD,
		input_audio_transcription: null,
	});
	if (!general) {
		record('0.8 transcription disable (C5)', 'SKIP', 'no audio tooling');
		c.close();
		return;
	}
	c.streamAudio(general);
	const tr = await c.waitFor(
		(e) => typeof e.type === 'string' && e.type.includes('input_audio_transcription'),
		8000,
	);
	record(
		'0.8 transcription disable (C5)',
		tr ? 'STILL-EMITS' : 'SUPPRESSED',
		tr ? (tr.type ?? '') : 'no transcription events',
	);
	c.close();
}

async function probe09_voices() {
	const candidates = [
		'Tina',
		'Cherry',
		'Ethan',
		'Chelsie',
		'Serena',
		'Jada',
		'Dylan',
		'Sunny',
		'Kiki',
		'Eric',
		'Nofish',
	];
	const okv: string[] = [];
	const badv: string[] = [];
	for (const v of candidates) {
		const c = await Conn.open();
		const r = await c.sessionUpdate({
			modalities: ['text', 'audio'],
			voice: v,
			turn_detection: SERVER_VAD,
		});
		if (r?.type === 'session.updated') okv.push(v);
		else badv.push(v);
		c.close();
		await sleep(150);
	}
	record('0.9 voices (V1q)', okv.join(',') || '(none)', `rejected: ${badv.join(',') || 'none'}`);
}

async function probe05_c3(general: Buffer | null) {
	if (!general) {
		record('0.5 interrupt ownership (C3)', 'SKIP', 'no audio tooling');
		return;
	}
	const c = await Conn.open();
	await c.sessionUpdate({ modalities: ['text', 'audio'], turn_detection: SERVER_VAD });
	c.streamAudio(general);
	await c.waitFor((e) => e.type === 'response.created', 12000);
	// Model is now responding; barge in with more audio.
	await sleep(500);
	c.streamAudio(general);
	const cancelled = await c.waitFor(
		(e) => e.type === 'response.done' && JSON.stringify(e).includes('cancel'),
		6000,
	);
	const speechDuringGen = c.events.some((e) => e.type === 'input_audio_buffer.speech_started');
	record(
		'0.5 interrupt ownership (C3)',
		cancelled ? 'PROVIDER-AUTO-CANCEL' : 'NO-AUTO-CANCEL',
		`speech_started seen=${speechDuringGen}; cancelled=${!!cancelled}`,
	);
	c.close();
}

async function main() {
	console.log(`Probing ${MODEL} @ ${BASE}\n`);
	const general = synth('Hello, please tell me a short fun fact about the ocean.');
	const weather = synth('What is the current weather in Tokyo? Use your tools.');

	const vad = await probe01_serverVad(general).catch(
		(e) => (record('0.1 server_vad', 'ERR', String(e)), false),
	);
	await probe02_c6(general).catch((e) => record('0.2 C6', 'ERR', String(e)));
	await probe03_tools(weather).catch((e) => record('0.3 tools', 'ERR', String(e)));
	await probe04_o1text().catch((e) => record('0.4 O1-text', 'ERR', String(e)));
	await probe05_c3(general).catch((e) => record('0.5 C3', 'ERR', String(e)));
	await probe06_o3().catch((e) => record('0.6 O3', 'ERR', String(e)));
	await probe07_o4().catch((e) => record('0.7 O4', 'ERR', String(e)));
	await probe08_c5(general).catch((e) => record('0.8 C5', 'ERR', String(e)));
	await probe09_voices().catch((e) => record('0.9 voices', 'ERR', String(e)));

	console.log('\n\n================ PHASE 0 RESULTS ================');
	for (const r of results) console.log(`${r.probe.padEnd(42)} ${r.result}  ${r.detail}`);
	console.log('================================================');
	if (!vad) console.log('\n⚠ HARD GATE 0.1 server_vad did not pass — see detail above.');
	process.exit(0);
}

main();
