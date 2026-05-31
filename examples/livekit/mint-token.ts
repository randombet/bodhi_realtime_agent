// SPDX-License-Identifier: MIT
/**
 * Tiny helper for the standalone client: serves examples/livekit/client.html
 * and a `/token` endpoint so the page can connect with one click.
 *
 *   pnpm token            # serves http://127.0.0.1:8080
 *   pnpm token --print    # just print a token + URL and exit
 *
 * Uses LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET from the environment.
 * The HTML also works fully standalone — open it from disk and paste a URL +
 * token (e.g. from `lk token create` or the LiveKit Cloud dashboard).
 *
 * Security: this is a LOCAL dev helper. It binds to 127.0.0.1 only and mints a
 * token for a single fixed room with a server-generated identity — it does NOT
 * expose arbitrary token minting on the network. Do not deploy it as-is.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AccessToken } from 'livekit-server-sdk';

const URL_ = process.env.LIVEKIT_URL ?? '';
const KEY = process.env.LIVEKIT_API_KEY ?? '';
const SECRET = process.env.LIVEKIT_API_SECRET ?? '';
const PORT = Number(process.env.PORT) || 8080;
const ROOM = process.env.ROOM || 'bodhi';

if (!URL_ || !KEY || !SECRET) {
  console.error('Error: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET must be set.');
  process.exit(1);
}

async function mint(identity: string, room: string): Promise<string> {
  const at = new AccessToken(KEY, SECRET, { identity, ttl: '1h' });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
  return await at.toJwt();
}

if (process.argv.includes('--print')) {
  const token = await mint(`human-${Date.now()}`, ROOM);
  console.log(`LIVEKIT_URL=${URL_}`);
  console.log(`ROOM=${ROOM}`);
  console.log(`TOKEN=${token}`);
  process.exit(0);
}

const clientHtmlPath = fileURLToPath(new URL('./client.html', import.meta.url));

let identitySeq = 0;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/token') {
    // Fixed room + server-generated identity — the caller does not control either,
    // so this localhost helper can't be used to mint tokens for arbitrary rooms.
    const identity = `human-${Date.now()}-${identitySeq++}`;
    const token = await mint(identity, ROOM);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: URL_, room: ROOM, token }));
    return;
  }
  // serve the client at "/"
  try {
    const html = await readFile(clientHtmlPath, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end('client.html not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nBodhi client:  http://127.0.0.1:${PORT}`);
  console.log(`  LiveKit:     ${URL_}`);
  console.log(`  Room:        ${ROOM}`);
  console.log(`\nMake sure the agent worker is running:  pnpm dev\n`);
});
