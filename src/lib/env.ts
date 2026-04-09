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

  // Supabase
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),

  // LI.FI
  lifiApiKey: () => required("LIFI_API_KEY"),
  lifiIntegrator: () => optional("LIFI_INTEGRATOR") ?? "betpal",

  // App resolver key
  resolverPrivateKey: () => required("APP_RESOLVER_PRIVATE_KEY"),
  resolverAddress: () => required("APP_RESOLVER_ADDRESS"),

  // Base
  baseRpcUrl: () => optional("BASE_RPC_URL") ?? "https://mainnet.base.org",

  // Vault
  morphoVaultBase: () => required("MORPHO_USDC_VAULT_BASE"),
};

// Public env vars live in `./publicEnv.ts` so they can be imported from client
// components without dragging the `server-only` boundary along.
