import { InMemoryPostSessionPipeline, type PostSessionPipelineOptions } from './pipeline.js';
import { MemoryDistillationProcessor } from './processors/memory-distillation.js';
import type { PostSessionPipeline } from './types.js';

/**
 * Build a fresh default pipeline with the built-in processors registered and
 * frozen. Currently: memory distillation (required). Prefer {@link getDefaultPostSessionPipeline}
 * for production; use this in tests that need an isolated instance.
 */
export function createDefaultPostSessionPipeline(
	options?: PostSessionPipelineOptions,
): PostSessionPipeline {
	const pipeline = new InMemoryPostSessionPipeline(options);
	pipeline.register(new MemoryDistillationProcessor());
	pipeline.freeze();
	return pipeline;
}

let singleton: PostSessionPipeline | null = null;

/**
 * The process-scoped default pipeline, lazily created once. This is what
 * VoiceSession falls back to when no explicit pipeline is configured, so
 * post-session work (memory distillation) runs for every session by default.
 */
export function getDefaultPostSessionPipeline(): PostSessionPipeline {
	if (!singleton) singleton = createDefaultPostSessionPipeline();
	return singleton;
}
