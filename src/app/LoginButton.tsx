"use client";

import { usePrivy } from "@privy-io/react-auth";

export function LoginButton() {
  const { ready, authenticated, login, logout, user } = usePrivy();

  if (!ready) return <button disabled>Loading…</button>;

  if (authenticated) {
    return (
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span>
          Signed in as{" "}
          <strong>{user?.email?.address ?? user?.wallet?.address ?? "user"}</strong>
        </span>
        <button onClick={logout}>Sign out</button>
      </div>
    );
  }

  return <button onClick={login}>Sign in with Privy</button>;
}
