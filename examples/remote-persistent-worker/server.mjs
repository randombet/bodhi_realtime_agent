#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Remote persistent worker bridge (Node stdlib only).
 * POST /task — JSON { sessionId, task } + Authorization: Bearer <token>
 * Reply: { status: "completed"|"error", text: "..." }
 *
 * This implementation runs the local Claude CLI with resume support:
 * - First task for a Bodhi sessionId: `claude -p <task> --output-format json`
 * - Later tasks with same Bodhi sessionId: add `--resume <claudeSessionId>`
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.PORT) || 8788;
const HOST = process.env.HOST || '127.0.0.1';
const EXPECTED_TOKEN = process.env.BODHI_WORKER_TOKEN || 'dev-token';
const CLAUDE_CMD = process.env.CLAUDE_CMD || 'claude';
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS) || 180_000;
const CLAUDE_PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CLAUDE_PERMISSION_MODE = process.env.CLAUDE_PERMISSION_MODE || 'bypassPermissions';
const CLAUDE_DANGEROUS_SKIP_PERMISSIONS =
	(process.env.CLAUDE_DANGEROUS_SKIP_PERMISSIONS || '1').trim() !== '0';

/** @type {Map<string, { claudeSessionId?: string; taskCount: number }>} */
const sessionStateByBodhiSession = new Map();
let nextReqId = 1;

function now() {
	return new Date().toISOString();
}

function log(reqId, msg, extra) {
	if (extra !== undefined) {
		console.log(`${now()} [worker#${reqId}] ${msg}`, extra);
		return;
	}
	console.log(`${now()} [worker#${reqId}] ${msg}`);
}

function parseBodyJson(raw) {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function parseClaudeOutput(stdout) {
	const trimmed = stdout.trim();
	if (!trimmed) {
		return { text: '', claudeSessionId: undefined };
	}
	const parsedWhole = parseBodyJson(trimmed);
	if (parsedWhole && typeof parsedWhole === 'object' && !Array.isArray(parsedWhole)) {
		const o = /** @type {Record<string, unknown>} */ (parsedWhole);
		return {
			text:
				(typeof o.result === 'string' && o.result) ||
				(typeof o.text === 'string' && o.text) ||
				trimmed,
			claudeSessionId:
				(typeof o.session_id === 'string' && o.session_id) ||
				(typeof o.sdkSessionId === 'string' && o.sdkSessionId) ||
				(typeof o.sessionId === 'string' && o.sessionId) ||
				undefined,
		};
	}
	const lines = trimmed
		.split('\n')
		.map((l) => l.trim())
		.filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const p = parseBodyJson(lines[i]);
		if (p && typeof p === 'object' && !Array.isArray(p)) {
			const o = /** @type {Record<string, unknown>} */ (p);
			const text =
				(typeof o.result === 'string' && o.result) ||
				(typeof o.text === 'string' && o.text) ||
				trimmed;
			const claudeSessionId =
				(typeof o.session_id === 'string' && o.session_id) ||
				(typeof o.sdkSessionId === 'string' && o.sdkSessionId) ||
				(typeof o.sessionId === 'string' && o.sessionId) ||
				undefined;
			return { text, claudeSessionId };
		}
	}
	return { text: trimmed, claudeSessionId: undefined };
}

/**
 * @param {number} reqId
 * @param {string} task
 * @param {string | undefined} resumeId
 * @returns {Promise<{text: string; claudeSessionId?: string; exitCode: number; stderr: string; args: string[]}>}
 */
function runClaude(reqId, task, resumeId) {
	return new Promise((resolve, reject) => {
		const args = [
			'-p',
			task,
			'--output-format',
			'json',
			'--permission-mode',
			CLAUDE_PERMISSION_MODE,
		];
		if (CLAUDE_DANGEROUS_SKIP_PERMISSIONS) {
			args.push('--dangerously-skip-permissions');
		}
		if (CLAUDE_PROJECT_DIR) {
			args.push('--add-dir', CLAUDE_PROJECT_DIR);
		}
		if (resumeId) args.push('--resume', resumeId);
		log(reqId, 'claude exec', { cmd: CLAUDE_CMD, args, timeoutMs: CLAUDE_TIMEOUT_MS });

		const child = spawn(CLAUDE_CMD, args, {
			stdio: ['ignore', 'pipe', 'pipe'],
			cwd: CLAUDE_PROJECT_DIR,
			env: process.env,
		});
		let stdout = '';
		let stderr = '';
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			log(reqId, `claude timeout after ${CLAUDE_TIMEOUT_MS}ms, killing process`);
			child.kill('SIGTERM');
		}, CLAUDE_TIMEOUT_MS);

		child.stdout.on('data', (d) => {
			stdout += String(d);
		});
		child.stderr.on('data', (d) => {
			stderr += String(d);
		});
		child.on('error', (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			const parsed = parseClaudeOutput(stdout);
			resolve({
				text: parsed.text,
				claudeSessionId: parsed.claudeSessionId,
				exitCode: typeof code === 'number' ? code : 1,
				stderr: timedOut ? `${stderr}\n[TIMEOUT]` : stderr,
				args,
			});
		});
	});
}

function sendJson(res, statusCode, body) {
	const s = JSON.stringify(body);
	res.writeHead(statusCode, {
		'Content-Type': 'application/json',
		'Content-Length': Buffer.byteLength(s),
	});
	res.end(s);
}

function unauthorized(res) {
	sendJson(res, 401, { status: 'error', text: 'Unauthorized' });
}

const server = http.createServer(async (req, res) => {
	const reqId = nextReqId++;
	const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
	log(reqId, `incoming ${req.method} ${url.pathname}`);
	if (req.method !== 'POST' || url.pathname !== '/task') {
		res.writeHead(404);
		res.end();
		return;
	}

	const auth = req.headers.authorization || '';
	const m = /^Bearer\s+(.+)$/i.exec(auth);
	if (!m || m[1] !== EXPECTED_TOKEN) {
		log(reqId, 'auth failed');
		unauthorized(res);
		return;
	}

	let body = '';
	for await (const chunk of req) body += chunk;
	const payload = parseBodyJson(body);
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		log(reqId, 'invalid JSON body');
		sendJson(res, 400, { status: 'error', text: 'Invalid JSON body' });
		return;
	}

	const bodyObj = /** @type {Record<string, unknown>} */ (payload);
	const sessionId = typeof bodyObj.sessionId === 'string' ? bodyObj.sessionId : '';
	const task = typeof bodyObj.task === 'string' ? bodyObj.task : '';
	if (!sessionId || !task) {
		log(reqId, 'missing sessionId/task', { sessionIdPresent: !!sessionId, taskPresent: !!task });
		sendJson(res, 400, { status: 'error', text: 'Missing sessionId or task' });
		return;
	}
	log(reqId, 'request payload', {
		sessionId,
		taskPreview: task.slice(0, 200),
		taskChars: task.length,
	});

	const prior = sessionStateByBodhiSession.get(sessionId) ?? { taskCount: 0 };
	const resumeId = prior.claudeSessionId;
	const isResume = !!resumeId;

	try {
		const out = await runClaude(reqId, task, resumeId);
		if (out.exitCode !== 0) {
			log(reqId, 'claude failed', {
				exitCode: out.exitCode,
				stderr: out.stderr.slice(0, 400),
				stdoutPreview: out.text.slice(0, 400),
			});
			sendJson(res, 200, {
				status: 'error',
				text: out.stderr.trim() || `Claude exited with code ${out.exitCode}`,
			});
			return;
		}

		const nextSessionId = out.claudeSessionId || prior.claudeSessionId;
		sessionStateByBodhiSession.set(sessionId, {
			claudeSessionId: nextSessionId,
			taskCount: prior.taskCount + 1,
		});
		log(reqId, 'claude completed', {
			mode: isResume ? 'resume' : 'start',
			bodhiSessionId: sessionId,
			claudeSessionId: nextSessionId,
			taskCount: prior.taskCount + 1,
			resultPreview: out.text.slice(0, 300),
		});
		sendJson(res, 200, { status: 'completed', text: out.text });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log(reqId, 'bridge error', msg);
		sendJson(res, 200, { status: 'error', text: `Bridge failed: ${msg}` });
	}
});

server.listen(PORT, HOST, () => {
	console.log(`Remote persistent worker demo at http://${HOST}:${PORT}/task`);
	console.log(`Bearer token: ${EXPECTED_TOKEN}`);
	console.log(`Claude command: ${CLAUDE_CMD}`);
	console.log(`Claude timeout: ${CLAUDE_TIMEOUT_MS}ms`);
	console.log(`Claude project dir: ${CLAUDE_PROJECT_DIR}`);
	console.log(`Claude permission mode: ${CLAUDE_PERMISSION_MODE}`);
	console.log(`Dangerous skip permissions: ${CLAUDE_DANGEROUS_SKIP_PERMISSIONS ? 'on' : 'off'}`);
});
