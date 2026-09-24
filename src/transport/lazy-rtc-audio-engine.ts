import type { RtcAudioEngine, RtcAudioEngineOptions } from '../types/rtc-engine.js';
import type { RtcClientSignalingMessage } from '../types/rtc-signaling.js';

/** Shape of the internal engine entry (type-only: never bundled from here). */
export type DirectRtcModule = typeof import('../direct-rtc/index.js');

/** Loads the module that ships the engine; injectable so tests can stub it. */
export type DirectRtcModuleLoader = () => Promise<DirectRtcModule>;

/** The package's private import that maps to the built engine entry. */
const DIRECT_RTC_ENTRY = '#direct-rtc';

// Both specifiers are assembled at runtime so bundlers neither follow nor warn about
// them: werift and `@evan/opus` stay out of the root entry's import graph.
const packageImportSpecifier = (): string => ['#', 'direct-rtc'].join('');
const sourceModuleSpecifier = (): string => ['..', 'direct-rtc', 'index.js'].join('/');

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Default loader. It first imports the package's private `#direct-rtc` import (Node
 * resolves a package's `imports` for the package's own files, so this is the path a
 * built install takes). If that import fails, which is what happens in source-mode runs
 * inside this repository before `pnpm build` because the mapping points into `dist`, it
 * imports the source module next to this file instead. When both fail, the error carries
 * both reasons, the package import first.
 */
export const loadDirectRtcModule: DirectRtcModuleLoader = async () => {
	try {
		return (await import(packageImportSpecifier())) as DirectRtcModule;
	} catch (entryError) {
		try {
			return (await import(sourceModuleSpecifier())) as DirectRtcModule;
		} catch (sourceError) {
			throw new Error(
				`${errorMessage(entryError)} (source module fallback: ${errorMessage(sourceError)})`,
				{ cause: entryError },
			);
		}
	}
};

/**
 * Internal engine for `rtcAudio: 'werift_opus'`: loads the shipped engine from the
 * internal `#direct-rtc` entry on the first client signaling message (exactly once),
 * then delegates to it. Until then `mediaReady` is false and assistant PCM is left to the
 * channel's pre-media buffer. A failed load logs a line naming the internal engine entry
 * and emits one `rtc.error` frame, unless the engine was disposed first (then it only logs).
 */
export class LazyRtcAudioEngine implements RtcAudioEngine {
	private engine: RtcAudioEngine | null = null;
	private loading: Promise<RtcAudioEngine | null> | null = null;
	private disposed = false;

	constructor(
		private readonly options: RtcAudioEngineOptions,
		private readonly load: DirectRtcModuleLoader = loadDirectRtcModule,
	) {}

	get mediaReady(): boolean {
		return this.engine?.mediaReady ?? false;
	}

	async handleClientSignaling(msg: RtcClientSignalingMessage): Promise<void> {
		if (this.disposed) return;
		const engine = await this.ensureLoaded();
		if (!engine || this.disposed) return;
		await engine.handleClientSignaling(msg);
	}

	sendAssistantPcm(pcm: Buffer): void {
		this.engine?.sendAssistantPcm(pcm);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		if (this.loading) await this.loading;
		const engine = this.engine;
		this.engine = null;
		await engine?.dispose();
	}

	private ensureLoaded(): Promise<RtcAudioEngine | null> {
		if (!this.loading) this.loading = this.loadOnce();
		return this.loading;
	}

	private async loadOnce(): Promise<RtcAudioEngine | null> {
		try {
			const mod = await this.load();
			this.engine = mod.createWeriftOpusRtcEngine(this.options);
			return this.engine;
		} catch (err) {
			const m = errorMessage(err);
			const line = `[LazyRtcAudioEngine] failed to load the internal RTC engine entry ${DIRECT_RTC_ENTRY}: ${m}`;
			if (this.options.onLog) this.options.onLog(line);
			else console.error(line);
			// Disposed while loading: the channel is being torn down, so there is no client
			// left to tell; the failure stays in the server log only.
			if (this.disposed) return null;
			// The reason (which can name server paths) stays in the server log.
			this.options.emitServerJson({
				type: 'rtc.error',
				message: `RTC audio engine unavailable: failed to load ${DIRECT_RTC_ENTRY}`,
			});
			return null;
		}
	}
}
