#!/usr/bin/env node

/**
 * Serves examples/embed-widget-dump/index.html on a separate port so
 * POST /api/embed/widget-sessions sees a distinct browser Origin from the Bodhi web app.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname);
const HOST = process.env.HOST || '127.0.0.1';
/** When unset, default 8765; if busy, fall back to ephemeral port unless `PORT` is explicitly set. */
const portFromEnv = process.env.PORT?.trim();
const pinnedPort = portFromEnv !== undefined && portFromEnv !== '';
let listenPort = pinnedPort ? Number(portFromEnv) : 8765;
if (pinnedPort && (Number.isNaN(listenPort) || listenPort < 0)) {
	console.error(`Invalid PORT: ${process.env.PORT}`);
	process.exit(1);
}

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
};

function safeJoin(root, urlPath) {
	const rel = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
	const abs = path.join(root, rel);
	if (!abs.startsWith(root)) return null;
	return abs;
}

const server = http.createServer((req, res) => {
	try {
		const u = new URL(req.url || '/', `http://${HOST}`);
		const pathname = u.pathname === '/' ? '/index.html' : u.pathname;
		const filePath = safeJoin(ROOT, pathname);
		if (!filePath) {
			res.writeHead(403);
			res.end('Forbidden');
			return;
		}
		fs.readFile(filePath, (err, data) => {
			if (err) {
				res.writeHead(404);
				res.end('Not found');
				return;
			}
			const ext = path.extname(filePath);
			res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
			res.writeHead(200);
			res.end(data);
		});
	} catch {
		res.writeHead(400);
		res.end('Bad request');
	}
});

function actualPort() {
	const a = server.address();
	if (a && typeof a === 'object') return a.port;
	return listenPort;
}

server.on('error', (err) => {
	if (err.code === 'EADDRINUSE' && !pinnedPort && listenPort !== 0) {
		console.warn(
			`Port ${listenPort} is already in use; listening on an ephemeral port instead (set PORT=… to pin).`,
		);
		listenPort = 0;
		server.listen(listenPort, HOST);
		return;
	}
	console.error(err.message);
	process.exit(1);
});

server.listen(listenPort, HOST, () => {
	const p = actualPort();
	console.log(`embed-widget-dump listening on http://${HOST}:${p}/`);
	console.log('Add this exact origin to your widget allowlist before publishing.');
});
