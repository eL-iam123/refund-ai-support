/** Minimal logger contract: satisfied by Fastify's pino instance and by the console fallback. */
export interface Logger {
  info(payload: unknown, message?: string): void;
  warn(payload: unknown, message?: string): void;
  error(payload: unknown, message?: string): void;
  debug(payload: unknown, message?: string): void;
}

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

export const silentLogger: Logger = silent;

export const consoleLogger: Logger = {
  info: (payload, message) => {
    process.stdout.write(`${format(message, payload)}\n`);
  },
  warn: (payload, message) => {
    process.stderr.write(`${format(message, payload)}\n`);
  },
  error: (payload, message) => {
    process.stderr.write(`${format(message, payload)}\n`);
  },
  debug: () => undefined,
};

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/**
 * Resolves a level to a concrete logger. `silent` is the escape hatch used by
 * the test suite, so tests never write to stdout.
 */
export function createLogger(level: LogLevel): Logger {
  if (level === 'silent') {
    return silent;
  }
  if (level === 'debug' || level === 'trace') {
    return { ...consoleLogger, debug: (payload, message) => consoleLogger.info(payload, message) };
  }
  return consoleLogger;
}

function format(message: string | undefined, payload: unknown): string {
  const head = message ?? '';
  if (typeof payload === 'string') {
    return head.length === 0 ? payload : `${head} ${payload}`;
  }
  return head.length === 0 ? JSON.stringify(payload) : `${head} ${JSON.stringify(payload)}`;
}
