// SPDX-License-Identifier: MIT

import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import writeFileAtomic from 'write-file-atomic';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Persisted device identity file format (v1). */
interface DeviceIdentityFile {
	version: 1;
	deviceId: string;
	publicKeyPem: string;
	privateKeyPem: string;
	createdAtMs: number;
}

/** Runtime device identity used by OpenClawClient for challenge-response auth. */
export interface DeviceIdentity {
	/** SHA-256 of raw 32-byte Ed25519 public key, lowercase hex (64 chars). */
	deviceId: string;
	/** Raw 32-byte Ed25519 public key, base64url encoded (no padding). */
	publicKeyBase64url: string;
	/** PKCS8 PEM private key (kept in memory for signing). */
	privateKeyPem: string;
}

/** Parameters for constructing a signature payload. */
export interface SignChallengeParams {
	clientId: string;
	clientMode: string;
	role: string;
	scopes: string[];
	signedAtMs: number;
	token: string;
	nonce: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_IDENTITY_PATH = join(homedir(), '.bodhi', 'device-identity.json');

/**
 * ASN.1 DER header length for Ed25519 SPKI public keys.
 * Full SPKI DER is always 44 bytes: 12-byte header + 32-byte raw key.
 */
const ED25519_SPKI_HEADER_LENGTH = 12;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load an existing device identity from disk, or generate a new Ed25519 keypair
 * and persist it. The identity file is stored with 0600 permissions.
 */
export async function loadOrCreateDeviceIdentity(
	path: string = DEFAULT_IDENTITY_PATH,
): Promise<DeviceIdentity> {
	const existing = await loadIdentityFile(path);
	if (existing) {
		return toRuntimeIdentity(existing);
	}

	const file = generateIdentityFile();

	await mkdir(dirname(path), { recursive: true });
	await writeFileAtomic(path, JSON.stringify(file, null, 2), { mode: 0o600 });

	return toRuntimeIdentity(file);
}

/**
 * Sign a challenge payload using the device's Ed25519 private key.
 * Uses the v2 pipe-delimited format:
 *   v2|deviceId|clientId|clientMode|role|scopes|signedAtMs|token|nonce
 *
 * Returns the signature as a base64url string (no padding).
 */
export function signChallengePayload(
	identity: DeviceIdentity,
	params: SignChallengeParams,
): string {
	// Use v2 payload format for broad gateway compatibility.
	// (v3 adds platform/deviceFamily but requires newer gateway versions.)
	const payload = [
		'v2',
		identity.deviceId,
		params.clientId,
		params.clientMode,
		params.role,
		params.scopes.join(','),
		String(params.signedAtMs),
		params.token,
		params.nonce,
	].join('|');

	const signature = sign(null, Buffer.from(payload, 'utf8'), identity.privateKeyPem);
	return toBase64url(signature);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function loadIdentityFile(path: string): Promise<DeviceIdentityFile | null> {
	try {
		const raw = await readFile(path, 'utf-8');
		const parsed = JSON.parse(raw) as Partial<DeviceIdentityFile>;

		if (
			parsed.version !== 1 ||
			typeof parsed.deviceId !== 'string' ||
			typeof parsed.publicKeyPem !== 'string' ||
			typeof parsed.privateKeyPem !== 'string'
		) {
			return null; // Corrupt or incompatible — regenerate
		}

		return parsed as DeviceIdentityFile;
	} catch {
		return null; // ENOENT or parse error
	}
}

function generateIdentityFile(): DeviceIdentityFile {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');

	const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
	const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

	const rawPublicKey = extractRawPublicKey(publicKeyPem);
	const deviceId = createHash('sha256').update(rawPublicKey).digest('hex');

	return {
		version: 1,
		deviceId,
		publicKeyPem,
		privateKeyPem,
		createdAtMs: Date.now(),
	};
}

function toRuntimeIdentity(file: DeviceIdentityFile): DeviceIdentity {
	const rawPublicKey = extractRawPublicKey(file.publicKeyPem);

	return {
		deviceId: file.deviceId,
		publicKeyBase64url: toBase64url(rawPublicKey),
		privateKeyPem: file.privateKeyPem,
	};
}

/** Extract the raw 32-byte Ed25519 public key from a PEM-encoded SPKI key. */
function extractRawPublicKey(publicKeyPem: string): Buffer {
	const keyObj = createPublicKey(publicKeyPem);
	const spkiDer = keyObj.export({ type: 'spki', format: 'der' });
	return spkiDer.subarray(ED25519_SPKI_HEADER_LENGTH);
}

/** Convert a Buffer to base64url encoding (no padding). */
function toBase64url(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
