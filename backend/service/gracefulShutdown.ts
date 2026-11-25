export interface ShutdownStep {
	name: string;
	run: () => Promise<void> | void;
}

export interface GracefulShutdownLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

export interface GracefulShutdownOptions {
	steps: ShutdownStep[];
	timeoutMs: number;
	logger?: GracefulShutdownLogger;
	onComplete?: (exitCode: number) => void;
}

export type GracefulShutdown = (reason: string, exitCode?: number) => Promise<boolean>;

async function runStep(step: ShutdownStep, timeoutMs: number, logger: GracefulShutdownLogger): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined;

	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => resolve(false), timeoutMs);
	});

	try {
		const completed = await Promise.race([
			Promise.resolve()
				.then(step.run)
				.then(() => true as const)
				.catch((error: unknown) => {
					logger.error(`[shutdown] ${step.name} failed: ${(error as Error).message}`);
					return false as const;
				}),
			timeout,
		]);

		if (!completed) {
			logger.warn(`[shutdown] ${step.name} did not finish within ${timeoutMs}ms`);
		}

		return completed;
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Runs each shutdown step at most once. A failing or hanging step is reported
 * but does not prevent the remaining cleanup steps from running.
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdown {
	const logger = options.logger ?? console;
	let running: Promise<boolean> | undefined;

	return (reason: string, exitCode = 0): Promise<boolean> => {
		if (running) return running;

		running = (async () => {
			logger.info(`[shutdown] Starting (${reason})`);

			let clean = true;

			for (const step of options.steps) {
				const completed = await runStep(step, options.timeoutMs, logger);

				if (!completed) clean = false;
			}

			logger.info(`[shutdown] Cleanup ${clean ? "complete" : "completed with warnings"}`);

			options.onComplete?.(clean ? exitCode : 1);

			return clean;
		})();

		return running;
	};
}
