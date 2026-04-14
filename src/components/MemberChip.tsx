"use client";

/**
 * MemberChip — clickable Win98 chip showing a member's name.
 *
 * Click the name to copy the wallet address to the clipboard; a short
 * "Copied!" tooltip confirms. Optional `onSend` wires a small → send
 * button next to the name for the peer-to-peer transfer flow.
 */
import { useState, useEffect, type CSSProperties } from "react";
import { shortAddr } from "@/lib/format";

export type MemberChipProps = {
  name: string | null;
  address: string | null;
  role?: string | null;
  /** If set, renders a small "→$" button that triggers send-to-member. */
  onSend?: () => void;
};

export function MemberChip({ name, address, role, onSend }: MemberChipProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const label = name || (address ? shortAddr(address) : "Unknown");
  const canCopy = Boolean(address);

  async function handleCopy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Silent — some browsers block clipboard without HTTPS or user gesture
      // mismatch. Not worth breaking the UI over.
    }
  }

  const chipStyle: CSSProperties = {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 8px",
    background: role === "owner" ? "#e6e8ff" : "#f0f0f0",
    border: "1px solid #ccc",
    fontSize: 12,
  };

  return (
    <span style={chipStyle}>
      <button
        type="button"
        onClick={handleCopy}
        disabled={!canCopy}
        title={address ?? undefined}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          margin: 0,
          font: "inherit",
          color: "inherit",
          cursor: canCopy ? "pointer" : "default",
          textDecoration: canCopy ? "underline dotted" : "none",
        }}
      >
        {label}
      </button>
      {role === "owner" && (
        <span style={{ fontSize: 10, opacity: 0.6 }}>owner</span>
      )}
      {onSend && (
        <button
          type="button"
          onClick={onSend}
          title="Send funds to this member"
          style={{
            fontSize: 10,
            padding: "0 4px",
            minWidth: 0,
            lineHeight: "14px",
          }}
        >
          →$
        </button>
      )}
      {copied && (
        <span
          role="status"
          style={{
            position: "absolute",
            left: "50%",
            top: "-22px",
            transform: "translateX(-50%)",
            padding: "2px 6px",
            background: "#000",
            color: "#fff",
            fontSize: 10,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 5,
          }}
        >
          Copied!
        </span>
      )}
    </span>
  );
}
