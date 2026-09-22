import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

export interface AvatarDrivingConfig {
	apiKey: string;
	appId: string;
	avatarId: string;
	region?: 'us-west' | 'ap-northeast';
	sampleRate?: number;
	bridgePath?: string;
	pythonPath?: string;
}

export class AvatarDrivingProxy {
	private child: ChildProcess | null = null;
	private ready = false;

	onFrame?: (frameBase64: string, isLast: boolean) => void;
	onError?: (message: string) => void;
	onReady?: (connectionId: string) => void;
	onClose?: () => void;

	constructor(private readonly config: AvatarDrivingConfig) {}

	async start(): Promise<void> {
		if (this.child) return;
		const bridgePath =
			this.config.bridgePath ?? path.resolve(import.meta.dirname, './bridge/avatar_bridge.py');
		const pythonPath = this.config.pythonPath ?? 'python3';

		this.child = spawn(pythonPath, [bridgePath], {
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		const stdout = this.child.stdout;
		if (!stdout) throw new Error('Avatar bridge started without stdout');
		const rl = createInterface({ input: stdout });
		rl.on('line', (line) => {
			try {
				const msg = JSON.parse(line) as Record<string, unknown>;
				this.handleMessage(msg);
			} catch {
				// Ignore malformed bridge output lines.
			}
		});
		this.child.stderr?.on('data', (d: Buffer) => {
			const text = d.toString().trim();
			if (text) console.log(`[AvatarBridge] ${text}`);
		});
		this.child.on('exit', (code) => {
			console.log(`[AvatarBridge] exited code=${code}`);
			this.ready = false;
			this.child = null;
			this.onClose?.();
		});

		return new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error('Avatar bridge init timeout (30s)'));
			}, 30_000);
			const origOnReady = this.onReady;
			const origOnError = this.onError;

			this.onReady = (connectionId) => {
				clearTimeout(timeout);
				this.ready = true;
				this.onReady = origOnReady;
				origOnReady?.(connectionId);
				resolve();
			};
			this.onError = (message) => {
				clearTimeout(timeout);
				this.onError = origOnError;
				origOnError?.(message);
				reject(new Error(message));
			};

			this.send({
				type: 'init',
				apiKey: this.config.apiKey,
				appId: this.config.appId,
				avatarId: this.config.avatarId,
				region: this.config.region ?? 'us-west',
				sampleRate: this.config.sampleRate ?? 24000,
			});
		});
	}

	sendAudio(audioBuffer: Buffer, end = false): void {
		if (!this.ready) return;
		this.send({
			type: 'audio',
			data: audioBuffer.toString('base64'),
			end,
		});
	}

	interrupt(): void {
		if (!this.ready) return;
		this.send({ type: 'interrupt' });
	}

	async close(): Promise<void> {
		if (!this.child) return;
		this.send({ type: 'close' });
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.child?.kill();
				resolve();
			}, 5_000);
			const onClose = this.onClose;
			this.onClose = () => {
				clearTimeout(timeout);
				this.onClose = onClose;
				onClose?.();
				resolve();
			};
		});
		this.ready = false;
		this.child = null;
	}

	private send(msg: Record<string, unknown>): void {
		if (!this.child?.stdin?.writable) return;
		this.child.stdin.write(`${JSON.stringify(msg)}\n`);
	}

	private handleMessage(msg: Record<string, unknown>): void {
		switch (msg.type) {
			case 'ready':
				this.onReady?.(String(msg.connectionId ?? ''));
				break;
			case 'frame':
				this.onFrame?.(String(msg.data ?? ''), Boolean(msg.last));
				break;
			case 'error':
				this.onError?.(String(msg.message ?? 'Unknown bridge error'));
				break;
			case 'closed':
				this.onClose?.();
				break;
		}
	}
}
