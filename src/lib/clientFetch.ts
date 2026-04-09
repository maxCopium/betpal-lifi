"use client";

/**
 * Authed fetch wrapper for client components.
 *
 * Uses Privy's `getAccessToken()` to grab the current user's access token and
 * attach it as a Bearer header. Server routes verify the token via
 * `requireUser()` in `src/lib/auth.ts`.
 *
 * Throws on non-2xx responses with the JSON `{error}` message when present.
 */
import { getAccessToken } from "@privy-io/react-auth";

export async function authedFetch<T = unknown>(
  input: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new Error("not signed in");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(input, { ...init, headers });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not json
  }
  if (!res.ok) {
    const errField =
      json && typeof json === "object" && "error" in json
        ? (json as { error?: string }).error
        : undefined;
    throw new Error(errField ?? `request failed (${res.status})`);
  }
  return json as T;
}
