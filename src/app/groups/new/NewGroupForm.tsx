"use client";

/**
 * NewGroupForm — Win98-styled form for creating a betting group.
 *
 * Day 2 scope:
 *   - name input
 *   - the creator is the first member implicitly
 *   - additional members are deferred to the invite-link flow
 *   - on success: redirect to /groups/[id]
 *
 * Auth: requires the user to be signed in via Privy. If not signed in,
 * shows a sign-in prompt instead of the form.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { authedFetch } from "@/lib/clientFetch";

type CreatedGroup = {
  id: string;
  name: string;
  safe_address: `0x${string}`;
  threshold: number;
  status: string;
};

export function NewGroupForm() {
  const router = useRouter();
  const { ready, authenticated, login } = usePrivy();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!ready) return <p>Loading…</p>;
  if (!authenticated) {
    return (
      <div className="flex flex-col gap-3">
        <p>You need to sign in before creating a group.</p>
        <div>
          <button onClick={() => login()}>Sign in</button>
        </div>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Group name is required.");
      return;
    }
    setSubmitting(true);
    try {
      const group = await authedFetch<CreatedGroup>("/api/groups", {
        method: "POST",
        body: JSON.stringify({ name: trimmed, memberIds: [] }),
      });
      router.push(`/groups/${group.id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="field-row-stacked">
        <label htmlFor="group-name">Group name</label>
        <input
          id="group-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          disabled={submitting}
          placeholder="Friday Night Degens"
        />
      </div>
      <p className="text-xs">
        You will be the first member. Invite friends after the group is created.
      </p>
      {error && (
        <p className="text-xs" role="alert" style={{ color: "#a00" }}>
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button type="submit" disabled={submitting}>
          {submitting ? "Creating…" : "Create group"}
        </button>
        <button type="button" onClick={() => router.back()} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}
