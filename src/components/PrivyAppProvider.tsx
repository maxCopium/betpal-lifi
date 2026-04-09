"use client";

/**
 * Privy provider — wraps the app in a client boundary.
 * Configured for embedded wallets on Base, with email + Google login.
 *
 * The Privy app id is read from NEXT_PUBLIC_PRIVY_APP_ID. If unset, we render
 * children without the provider so the UI still loads in dev/demo mode.
 */
import { PrivyProvider } from "@privy-io/react-auth";
import { base } from "viem/chains";
import type { ReactNode } from "react";
import { publicEnv } from "@/lib/publicEnv";

export function PrivyAppProvider({ children }: { children: ReactNode }) {
  const appId = publicEnv.privyAppId;
  if (!appId) {
    // Avoid crashing the dev shell when the env var is missing.
    return <>{children}</>;
  }
  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "google", "wallet"],
        embeddedWallets: {
          ethereum: { createOnLogin: "users-without-wallets" },
        },
        defaultChain: base,
        supportedChains: [base],
        appearance: {
          theme: "light",
          accentColor: "#000080",
          logo: undefined,
        },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
