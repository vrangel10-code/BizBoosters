import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { ApiError } from './errors';

export const json = <T>(data: T, init?: ResponseInit) => NextResponse.json(data, init);

export const created = <T>(data: T) => NextResponse.json(data, { status: 201 });

export const noContent = () => new NextResponse(null, { status: 204 });

function errorBody(code: string, message: string, details: Record<string, unknown>) {
  return { error: { code, message, details } };
}

/**
 * Wraps a route handler so every thrown ApiError becomes its documented status
 * and code, and anything unexpected becomes a 500 that leaks nothing.
 */
export function handle<Args extends unknown[]>(
  fn: (...args: Args) => Promise<NextResponse>,
): (...args: Args) => Promise<NextResponse> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof ApiError) {
        const response = NextResponse.json(
          errorBody(error.code, error.message, error.details),
          { status: error.status },
        );
        if (error.code === 'rate_limited') {
          const retry = error.details.retry_after_seconds;
          if (typeof retry === 'number') response.headers.set('Retry-After', String(retry));
        }
        return response;
      }

      if (error instanceof ZodError) {
        return NextResponse.json(
          errorBody('validation_failed', 'The request body was not valid.', {
            issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          }),
          { status: 422 },
        );
      }

      console.error('[unhandled]', error);
      return NextResponse.json(
        errorBody('internal_error', 'Something went wrong.', {}),
        { status: 500 },
      );
    }
  };
}

/** Best-effort client IP, for rate-limit keys only — never for authorization. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip') ?? 'unknown';
}

export async function parseBody<T>(
  request: Request,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  return schema.parse(raw);
}
