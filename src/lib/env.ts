/**
 * Centralized env access. Throws loudly on the server if a required server var
 * is missing. Public vars (NEXT_PUBLIC_*) are inlined by Next at build time.
 */
import "server-only";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const env = {
  // Privy
  privyAppId: () => required("NEXT_PUBLIC_PRIVY_APP_ID"),
  privyAppSecret: () => required("PRIVY_APP_SECRET"),

  // Supabase (new API gateway keys)
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabasePublishableKey: () => required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
  supabaseSecretKey: () => required("SUPABASE_SECRET_KEY"),

  // LI.FI
  lifiApiKey: () => required("LIFI_API_KEY"),
  lifiIntegrator: () => optional("LIFI_INTEGRATOR") ?? "betpal",

  // Base
  baseRpcUrl: () => optional("BASE_RPC_URL") ?? "https://mainnet.base.org",

  // Vault
  morphoVaultBase: () => required("MORPHO_USDC_VAULT_BASE"),

  // Cron
  cronSecret: () => optional("CRON_SECRET"),
};

// Public env vars live in `./publicEnv.ts` so they can be imported from client
// components without dragging the `server-only` boundary along.
