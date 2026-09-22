import { PostSessionProcessor } from '../types.js';
import type { PostSessionContext } from '../types.js';

/**
 * Runs final memory distillation for an ended session. Marked `required` so it is
 * never shed by backpressure — under drain mode this preserves the legacy "final
 * extraction attempted before close resolves" guarantee.
 *
 * v1 bridge: it invokes the per-session `ctx.stores.memoryExtraction` capability
 * (which closes over the session's distiller). The processor itself holds no
 * session state, so it stays reentrant across concurrent session ends. A future
 * stateless service will consume `ctx.conversation` + `ctx.stores.memory` + a
 * model directly, and this bridge can retire without changing the contract.
 */
export class MemoryDistillationProcessor extends PostSessionProcessor {
	readonly name = 'memory-distillation';
	readonly required = true;

	shouldRun(ctx: PostSessionContext): boolean {
		return typeof ctx.stores.memoryExtraction === 'function';
	}

	async run(ctx: PostSessionContext): Promise<Record<string, unknown>> {
		await ctx.stores.memoryExtraction?.();
		return { extracted: true };
	}
}
