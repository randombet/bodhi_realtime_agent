/**
 * Qwen Omni Realtime — capture exact event shapes for implementation.
 * Dumps a full audio turn and a full tool turn (function_call item shape,
 * usage shape, transcript shapes). Throwaway spike. NOT shipped.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const API_KEY = process.env.QWEN_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
const BASE =
	process.env.QWEN_REALTIME_URL ?? 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime';
const MODEL = process.env.QWEN_REALTIME_MODEL ?? 'qwen3.5-omni-plus-realtime';
const CHUNK = 3200;
const SILENCE = Buffer.alloc(16000 * 2 * 1.5, 0);

function synth(text: string): Buffer {
	const aiff = join(tmpdir(), 'qs.aiff');
	const pcm = join(tmpdir(), 'qs.pcm');
	execFileSync('say', ['-o', aiff, text], { stdio: 'ignore' });
	execFileSync('ffmpeg', ['-y', '-i', aiff, '-ar', '16000', '-ac', '1', '-f', 's16le', pcm], {
		stdio: 'ignore',
	});
	return Buffer.concat([readFileSync(pcm), SILENCE]);
}

type Ev = { type?: string; [k: string]: unknown };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open(): Promise<WebSocket> {
	const ws = new WebSocket(`${BASE}?model=${encodeURIComponent(MODEL)}`, {
		headers: { Authorization: `Bearer ${API_KEY}` },
	});
	return new Promise((res, rej) => {
		ws.on('open', () => res(ws));
		ws.on('error', rej);
	});
}

/** Print event types; for "interesting" events dump compact JSON (audio elided). */
function logger(tag: string) {
	return (raw: Buffer) => {
		let e: Ev;
		try {
			e = JSON.parse(raw.toString());
		} catch {
			return;
		}
		const t = e.type ?? '?';
		const interesting =
			t.includes('function_call') ||
			t === 'response.output_item.added' ||
			t === 'response.output_item.done' ||
			t === 'response.done' ||
			t === 'conversation.item.created' ||
			t.includes('input_audio_transcription') ||
			t === 'error';
		if (interesting) {
			const clone = JSON.parse(JSON.stringify(e));
			// elide big base64 audio
			const scrub = (o: unknown) => {
				if (o && typeof o === 'object') {
					for (const k of Object.keys(o as Record<string, unknown>)) {
						const v = (o as Record<string, unknown>)[k];
						if (k === 'delta' && typeof v === 'string' && v.length > 40)
							(o as Record<string, unknown>)[k] = `<${v.length} b64>`;
						else if (k === 'audio' && typeof v === 'string')
							(o as Record<string, unknown>)[k] = `<audio>`;
						else scrub(v);
					}
				}
			};
			scrub(clone);
			console.log(`${tag} ▶ ${JSON.stringify(clone)}`);
		} else {
			console.log(`${tag} · ${t}`);
		}
	};
}

async function audioTurn() {
	console.log('\n===== AUDIO TURN =====');
	const ws = await open();
	ws.on('message', logger('A'));
	const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
	send({
		type: 'session.update',
		session: {
			modalities: ['text', 'audio'],
			input_audio_format: 'pcm',
			output_audio_format: 'pcm',
			turn_detection: { type: 'server_vad' },
		},
	});
	await sleep(800);
	const pcm = synth('In one short sentence, what is the capital of France?');
	for (let i = 0; i < pcm.length; i += CHUNK)
		send({
			type: 'input_audio_buffer.append',
			audio: pcm.subarray(i, i + CHUNK).toString('base64'),
		});
	await sleep(12000);
	ws.close();
}

async function toolTurn() {
	console.log('\n===== TOOL TURN =====');
	const ws = await open();
	ws.on('message', logger('T'));
	const send = (m: Record<string, unknown>) => ws.send(JSON.stringify(m));
	send({
		type: 'session.update',
		session: {
			modalities: ['text', 'audio'],
			input_audio_format: 'pcm',
			output_audio_format: 'pcm',
			turn_detection: { type: 'server_vad' },
			tools: [
				{
					type: 'function',
					name: 'get_weather',
					description: 'Get current weather for a city',
					parameters: {
						type: 'object',
						properties: { city: { type: 'string' } },
						required: ['city'],
					},
				},
			],
			tool_choice: 'auto',
		},
	});
	await sleep(800);
	const pcm = synth('What is the current weather in Tokyo? Please use your weather tool.');
	for (let i = 0; i < pcm.length; i += CHUNK)
		send({
			type: 'input_audio_buffer.append',
			audio: pcm.subarray(i, i + CHUNK).toString('base64'),
		});
	await sleep(13000);
	ws.close();
}

async function main() {
	await audioTurn();
	await sleep(500);
	await toolTurn();
	await sleep(500);
	process.exit(0);
}
main();
