"use client";

/**
 * AcceptInviteForm — click-through to redeem an invite link.
 *
 * The user must be signed in. On success we redirect to /groups/[id].
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";

type AcceptResponse = {
  group_id: string;
  safe_address: string;
  threshold: number;
};

export function AcceptInviteForm({ token }: { token: string }) {
  const router = useRouter();
  const { ready, authenticated, login } = usePrivy();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ready) return <p>Loading…</p>;
  if (!authenticated) {
    return (
      <div className="flex flex-col gap-3">
        <p>You need to sign in to accept this invitation.</p>
        <div>
          <button onClick={() => login()}>Sign in</button>
        </div>
      </div>
    );
  }

  async function onAccept() {
    setError(null);
    setSubmitting(true);
    try {
      const data = await authedFetch<AcceptResponse>(
        `/api/invites/${encodeURIComponent(token)}/accept`,
        { method: "POST" },
      );
      router.push(`/groups/${data.group_id}`);
    } catch (e) {
      setError((e as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <p>You&apos;ve been invited to join a BetPal group.</p>
      <p className="text-xs">
        Accepting will add you to the group&apos;s shared Safe vault. The group cannot
        accept new members once anyone deposits funds, so accept while it&apos;s still
        pending.
      </p>
      {error && (
        <p className="text-xs" role="alert" style={{ color: "#a00" }}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button onClick={onAccept} disabled={submitting}>
          {submitting ? "Joining…" : "Accept invitation"}
        </button>
        <button onClick={() => router.push("/")} disabled={submitting}>
          Cancel
        </button>
      </div>
    </div>
  );
}
