/**
 * Public env vars — safe to import from client components.
 * NEXT_PUBLIC_* values are inlined by Next.js at build time.
 */
export const publicEnv = {
  privyAppId: process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "",
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  demoMode: process.env.NEXT_PUBLIC_BETPAL_DEMO_MODE === "true",
};
