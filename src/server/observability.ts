import { randomUUID } from 'node:crypto';

/**
 * Structured logging and error reporting.
 *
 * No vendor SDK is wired in: adding one that needs a DSN to do anything useful
 * would be untestable and would put a hard dependency in the request path for a
 * feature nobody can exercise yet. Instead everything funnels through
 * `reportError`, so pointing it at Sentry (or anything else) later is a change
 * in one function rather than a hunt through the codebase.
 *
 * Logs are JSON lines because every hosting platform's log viewer can filter
 * them and none of them can filter prose.
 */
export interface LogContext {
  request_id?: string;
  user_id?: string;
  room_id?: string;
  route?: string;
  [key: string]: unknown;
}

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, message: string, context: LogContext = {}): void {
  const line = JSON.stringify({
    level,
    message,
    at: new Date().toISOString(),
    ...context,
  });

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}

export const log = {
  debug: (message: string, context?: LogContext) =>
    process.env.NODE_ENV === 'development' ? emit('debug', message, context) : undefined,
  info: (message: string, context?: LogContext) => emit('info', message, context),
  warn: (message: string, context?: LogContext) => emit('warn', message, context),
  error: (message: string, context?: LogContext) => emit('error', message, context),
};

/**
 * The single funnel for unexpected failures.
 *
 * Never include the error message in anything sent to a user — messages leak
 * table names, file paths and occasionally values. The returned id is safe to
 * show, and is what ties a user's complaint to a log line.
 */
export function reportError(error: unknown, context: LogContext = {}): string {
  const errorId = context.request_id ?? randomUUID();

  log.error(error instanceof Error ? error.message : String(error), {
    ...context,
    error_id: errorId,
    stack: error instanceof Error ? error.stack : undefined,
    name: error instanceof Error ? error.name : typeof error,
  });

  // Wire a reporter here (Sentry.captureException, etc). Kept as a single
  // seam on purpose — see the module comment.
  return errorId;
}

export const newRequestId = (): string => randomUUID();
