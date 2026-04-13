"use client";

/**
 * Privy provider — wraps the app in a client boundary.
 * Configured for embedded wallets on Base, with email + Google login.
 *
 * The Privy app id is read from NEXT_PUBLIC_PRIVY_APP_ID. If unset, we render
 * children without the provider so the UI still loads in dev/demo mode.
 *
 * Uses useState + useEffect to avoid initializing Privy during SSG/SSR,
 * which crashes because Privy requires a browser context.
 */
import { PrivyProvider } from "@privy-io/react-auth";
import { base } from "viem/chains";
import { useState, useEffect, type ReactNode } from "react";
import { publicEnv } from "@/lib/publicEnv";

export function PrivyAppProvider({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const appId = publicEnv.privyAppId;
  if (!mounted) {
    // Don't render children until client-side mount so that Privy hooks
    // (useWallets, usePrivy, etc.) never fire outside the provider context.
    return null;
  }
  if (!appId) {
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
