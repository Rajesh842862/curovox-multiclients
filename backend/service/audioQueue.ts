type AudioTask = {
	key: string;
	run: () => Promise<void>;
};

export type AudioQueueStats = {
	queued: number;
	active: number;
	concurrency: number;
	maxQueueSize: number;
};

export type AudioTaskQueueOptions = {
	concurrency?: number;
	maxQueueSize?: number;
	onError?: (error: Error, key: string) => void;
	onDrop?: (key: string, reason: "queue-full", stats: AudioQueueStats) => void;
};

export type EnqueueResult = "enqueued" | "duplicate" | "full";

// Small in-process queue for non-critical audio work. The queue is deliberately
// process-local: TTS is an enhancement, not part of the alert delivery path, and
// the existing deployment does not use an external job system.
export class AudioTaskQueue {
	private readonly concurrency: number;
	private readonly maxQueueSize: number;
	private readonly onError?: (error: Error, key: string) => void;
	private readonly onDrop?: (
		key: string,
		reason: "queue-full",
		stats: AudioQueueStats
	) => void;
	private readonly queue: AudioTask[] = [];
	private readonly pendingKeys = new Set<string>();
	private readonly idleWaiters: Array<() => void> = [];
	private activeCount = 0;

	constructor(options: AudioTaskQueueOptions = {}) {
		this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
		this.maxQueueSize = Math.max(1, Math.floor(options.maxQueueSize ?? 1000));
		this.onError = options.onError;
		this.onDrop = options.onDrop;
	}

	has(key: string): boolean {
		return this.pendingKeys.has(key);
	}

	get size(): number {
		return this.queue.length;
	}

	get active(): number {
		return this.activeCount;
	}

	get stats(): AudioQueueStats {
		return {
			queued: this.queue.length,
			active: this.activeCount,
			concurrency: this.concurrency,
			maxQueueSize: this.maxQueueSize,
		};
	}

	// Deduplicates queued/running work by key. When saturated, the new task is
	// rejected rather than evicting already accepted work or growing unbounded.
	enqueue(key: string, run: () => Promise<void>): EnqueueResult {
		if (this.pendingKeys.has(key)) return "duplicate";

		if (this.queue.length >= this.maxQueueSize) {
			const stats = this.stats;

			console.error(`Audio queue is full; dropping task for ${key}`, stats);
			this.onDrop?.(key, "queue-full", stats);

			return "full";
		}

		this.pendingKeys.add(key);
		this.queue.push({ key, run });
		this.pump();

		return "enqueued";
	}

	waitForIdle(): Promise<void> {
		if (this.activeCount === 0 && this.queue.length === 0) return Promise.resolve();

		return new Promise((resolve) => {
			this.idleWaiters.push(resolve);
		});
	}

	private pump(): void {
		while (this.activeCount < this.concurrency && this.queue.length > 0) {
			const task = this.queue.shift();

			if (!task) return;

			this.activeCount += 1;

			Promise.resolve()
				.then(() => task.run())
				.catch((error) => {
					const err = error as Error;

					console.error(`Audio task failed (${task.key}):`, err.message);

					try {
						this.onError?.(err, task.key);
					} catch (callbackError) {
						console.error(
							"Audio queue onError callback failed:",
							(callbackError as Error).message
						);
					}
				})
				.finally(() => {
					this.activeCount -= 1;
					this.pendingKeys.delete(task.key);
					this.pump();
					this.notifyIfIdle();
				});
		}

		this.notifyIfIdle();
	}

	private notifyIfIdle(): void {
		if (this.activeCount !== 0 || this.queue.length !== 0) return;

		while (this.idleWaiters.length > 0) {
			this.idleWaiters.shift()?.();
		}
	}
}
