'use client';

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * Thin fetch wrapper that turns the documented error envelope into a typed
 * throw, so components branch on `code` and never parse `message`.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 204) return undefined as T;

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const envelope = body as ApiErrorBody | null;
    throw new ApiRequestError(
      envelope?.error?.code ?? 'internal_error',
      envelope?.error?.message ?? 'Something went wrong.',
      envelope?.error?.details ?? {},
    );
  }

  return body as T;
}
