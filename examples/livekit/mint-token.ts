// SPDX-License-Identifier: MIT
/**
 * Tiny helper for the standalone client: serves examples/livekit/client.html
 * and a `/token` endpoint so the page can connect with one click.
 *
 *   pnpm livekit:token            # serves http://localhost:8080
 *   pnpm livekit:token --print    # just print a token + URL and exit
 *
 * Uses LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET from the environment.
 * The HTML also works fully standalone — open it from disk and paste a URL +
 * token (e.g. from `lk token create` or the LiveKit Cloud dashboard).
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  if (url.pathname === '/token') {
    const identity = url.searchParams.get('identity') ?? `human-${Date.now()}`;
    const room = url.searchParams.get('room') ?? ROOM;
    const token = await mint(identity, room);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: URL_, room, token }));
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

server.listen(PORT, () => {
  console.log(`\nBodhi client:  http://localhost:${PORT}`);
  console.log(`  LiveKit:     ${URL_}`);
  console.log(`  Room:        ${ROOM}`);
  console.log(`\nMake sure the agent worker is running:  pnpm livekit:dev\n`);
});
