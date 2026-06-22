const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
    throw new ApiError(
      data.error?.code ?? 'UNKNOWN_ERROR',
      data.error?.message ?? res.statusText,
      res.status,
    );
  }

  return res.json() as Promise<T>;
}

export const api = {
  get:   <T>(path: string)                  => request<T>('GET',   path),
  post:  <T>(path: string, body: unknown)   => request<T>('POST',  path, body),
  patch: <T>(path: string, body: unknown)   => request<T>('PATCH', path, body),
};
