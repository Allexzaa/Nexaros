const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

async function request<T>(method: string, path: string, body?: unknown, tokenOverride?: string): Promise<T> {
  const token = tokenOverride ?? accessToken;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
  get:          <T>(path: string)                              => request<T>('GET',    path),
  getWithToken: <T>(path: string, token: string)               => request<T>('GET',    path, undefined, token),
  post:         <T>(path: string, body: unknown)               => request<T>('POST',   path, body),
  put:          <T>(path: string, body: unknown)               => request<T>('PUT',    path, body),
  patch:        <T>(path: string, body: unknown)               => request<T>('PATCH',  path, body),
  delete:       <T>(path: string)                              => request<T>('DELETE', path),
};
