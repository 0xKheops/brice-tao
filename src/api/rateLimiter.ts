/**
 * Token-bucket rate limiter with concurrency control for RPC calls.
 *
 * - `concurrency` limits how many tasks run in parallel (semaphore)
 * - `rpm` caps the total number of RPC calls per minute (token bucket)
 *
 * Each task declares an estimated RPC `cost`; the limiter waits for both
 * a free concurrency slot AND enough RPM tokens before starting the task.
 */

export interface RateLimiterOptions {
	/** Max parallel tasks (default: 1) */
	concurrency?: number;
	/** Max RPC calls per minute — omit or 0 for unlimited */
	rpm?: number;
}

export class RpcRateLimiter {
	private running = 0;
	private readonly waitQueue: Array<() => void> = [];
	private readonly concurrency: number;
	private readonly maxTokens: number;
	private tokens: number;
	private readonly refillRate: number;
	private lastRefill: number;

	constructor(opts: RateLimiterOptions = {}) {
		this.concurrency = Math.max(1, opts.concurrency ?? 1);
		const rpm = opts.rpm && opts.rpm > 0 ? opts.rpm : 0;
		this.maxTokens = rpm || Number.POSITIVE_INFINITY;
		this.tokens = this.maxTokens;
		this.refillRate = rpm ? rpm / 60_000 : 0;
		this.lastRefill = Date.now();
	}

	/**
	 * Run `fn` once a concurrency slot and enough RPM tokens are available.
	 * `cost` is the estimated number of RPC calls the task will make.
	 */
	async run<T>(fn: () => Promise<T>, cost = 1): Promise<T> {
		await this.acquireConcurrencySlot();
		try {
			await this.acquireTokens(cost);
			return await fn();
		} finally {
			this.running--;
			this.waitQueue.shift()?.();
		}
	}

	private acquireConcurrencySlot(): Promise<void> {
		if (this.running < this.concurrency) {
			this.running++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waitQueue.push(() => {
				this.running++;
				resolve();
			});
		});
	}

	private async acquireTokens(cost: number): Promise<void> {
		if (!Number.isFinite(this.maxTokens)) return;
		this.refill();
		while (this.tokens < cost) {
			const waitMs = Math.ceil((cost - this.tokens) / this.refillRate);
			await new Promise((r) => setTimeout(r, Math.max(waitMs, 50)));
			this.refill();
		}
		this.tokens -= cost;
	}

	private refill(): void {
		const now = Date.now();
		const elapsed = now - this.lastRefill;
		this.tokens = Math.min(
			this.maxTokens,
			this.tokens + elapsed * this.refillRate,
		);
		this.lastRefill = now;
	}
}
