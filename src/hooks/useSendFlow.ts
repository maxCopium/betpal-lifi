"use client";

/**
 * useSendFlow — peer-to-peer wallet send state machine.
 *
 *   - Same-chain USDC on Base: direct ERC-20 transfer, no LI.FI, no fees
 *     beyond gas.
 *   - Cross-chain OR non-USDC source: POST /api/send-quote to get a
 *     LI.FI Composer quote with toAddress = recipient, then sign it.
 *
 * Mirrors useDepositFlow's shape so <CopyProgressDialog> can render its
 * state without changes. No backend ledger writes — funds move wallet
 * to wallet, the group is just an address book here.
 */
import { useState, useCallback } from "react";
import { authedFetch } from "@/lib/clientFetch";
import { toBaseUnits } from "@/lib/amounts";
import { BASE_CHAIN_ID, USDC_BASE } from "@/lib/constants";

export type SendSource = {
  label: string;
  chainId: number;
  token: `0x${string}`;
  decimals: number;
  symbol: string;
};

type QuoteResponse = {
  quote: {
    id: string;
    transactionRequest: {
      to: string;
      data: string;
      value?: string;
      chainId?: number;
      gasLimit?: string;
      gasPrice?: string;
    };
    estimate: {
      toAmount: string;
      toAmountMin: string;
      executionDuration?: number;
      approvalAddress?: string;
    };
  };
};

/** Minimal Privy wallet surface (avoid pulling in the full SDK type). */
type Wallet = {
  address: string;
  walletClientType: string;
  switchChain: (chainId: number) => Promise<void>;
  getEthereumProvider: () => Promise<{
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  }>;
};

export type SendFlowParams = {
  source: SendSource;
  amount: string;
  wallet: Wallet;
  recipientAddress: `0x${string}`;
  recipientLabel: string;
};

export type SendFlowState = {
  open: boolean;
  status: string;
  progress: number | undefined;
  error: string | null;
  txHash: string | null;
  execute: (params: SendFlowParams) => Promise<void>;
  reset: () => void;
};

/** Pack an ERC-20 `transfer(address,uint256)` call into calldata. */
function encodeErc20Transfer(to: string, amountWei: bigint): string {
  // selector for transfer(address,uint256) = 0xa9059cbb
  const addr = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amt = amountWei.toString(16).padStart(64, "0");
  return `0xa9059cbb${addr}${amt}`;
}

export function useSendFlow(): SendFlowState {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const reset = useCallback(() => {
    setOpen(false);
    setStatus("");
    setProgress(undefined);
    setError(null);
    setTxHash(null);
  }, []);

  const execute = useCallback(async (params: SendFlowParams) => {
    const { source, amount, wallet, recipientAddress, recipientLabel } = params;
    setError(null);
    setTxHash(null);

    let fromAmount: string;
    try {
      fromAmount = toBaseUnits(amount, source.decimals);
      if (fromAmount === "0") throw new Error("amount must be > 0");
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    const isDirectBaseUsdc =
      source.chainId === BASE_CHAIN_ID &&
      source.token.toLowerCase() === USDC_BASE.toLowerCase();

    setOpen(true);
    setProgress(undefined);

    try {
      if (isDirectBaseUsdc) {
        // ── Direct ERC-20 transfer on Base, no LI.FI ──
        setStatus("Switching wallet to Base…");
        try {
          await wallet.switchChain(BASE_CHAIN_ID);
        } catch (e) {
          console.warn("switchChain failed (continuing):", e);
        }

        const provider = await wallet.getEthereumProvider();
        const data = encodeErc20Transfer(recipientAddress, BigInt(fromAmount));

        setStatus(`Sign transfer to ${recipientLabel}…`);
        const hash = (await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: wallet.address,
              to: USDC_BASE,
              data,
              value: "0x0",
            },
          ],
        })) as string;

        setTxHash(hash);
        setStatus("Waiting for confirmation…");
        // Poll the tx receipt — Base is ~2s per block, 30s cap.
        for (let i = 0; i < 20; i++) {
          const receipt = (await provider.request({
            method: "eth_getTransactionReceipt",
            params: [hash],
          })) as { status?: string } | null;
          if (receipt) {
            if (receipt.status === "0x1") {
              setProgress(100);
              setStatus(`Sent ${amount} USDC to ${recipientLabel}.`);
              return;
            }
            throw new Error("transfer reverted on-chain");
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        // Still pending after 30s — leave the dialog showing the tx hash.
        setProgress(95);
        setStatus("Submitted — still waiting for confirmation.");
        return;
      }

      // ── Cross-chain / non-USDC: LI.FI Composer routed to recipient ──
      setStatus("Quoting cross-chain route via LI.FI…");
      const res = await authedFetch<QuoteResponse>("/api/send-quote", {
        method: "POST",
        body: JSON.stringify({
          fromChain: source.chainId,
          fromToken: source.token,
          fromAmount,
          toAddress: recipientAddress,
        }),
      });

      setStatus("Switching wallet to source chain…");
      try {
        await wallet.switchChain(source.chainId);
      } catch (e) {
        console.warn("switchChain failed (continuing):", e);
      }

      const provider = await wallet.getEthereumProvider();
      const NATIVE = "0x0000000000000000000000000000000000000000";
      const approvalAddress = res.quote.estimate.approvalAddress;

      // ERC-20 approval if needed.
      if (approvalAddress && source.token.toLowerCase() !== NATIVE) {
        setStatus("Checking token allowance…");
        const allowanceData =
          "0xdd62ed3e" +
          wallet.address.slice(2).padStart(64, "0") +
          approvalAddress.slice(2).padStart(64, "0");
        const allowanceHex = (await provider.request({
          method: "eth_call",
          params: [{ to: source.token, data: allowanceData }, "latest"],
        })) as string;
        const allowance = BigInt(allowanceHex || "0x0");
        if (allowance < BigInt(fromAmount)) {
          setStatus("Approve token spend (1 of 2 signatures)…");
          const approveData =
            "0x095ea7b3" +
            approvalAddress.slice(2).padStart(64, "0") +
            "f".repeat(64);
          const approveHash = (await provider.request({
            method: "eth_sendTransaction",
            params: [{ from: wallet.address, to: source.token, data: approveData }],
          })) as string;
          setStatus("Waiting for approval confirmation…");
          for (let i = 0; i < 60; i++) {
            const receipt = await provider.request({
              method: "eth_getTransactionReceipt",
              params: [approveHash],
            });
            if (receipt) break;
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      }

      setStatus("Sign send transaction…");
      const sendHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: wallet.address,
            to: res.quote.transactionRequest.to,
            data: res.quote.transactionRequest.data,
            value: res.quote.transactionRequest.value ?? "0x0",
          },
        ],
      })) as string;
      setTxHash(sendHash);

      // Bridging time is ~2-60s. We don't have a confirm endpoint, so
      // just show indeterminate progress until the user closes.
      setStatus(
        `Routing via LI.FI — USDC will land in ${recipientLabel}'s wallet on Base.`,
      );
      setProgress(95);
    } catch (err) {
      setStatus("Failed.");
      const e = err as Record<string, unknown>;
      const msg =
        (typeof e.shortMessage === "string" && e.shortMessage) ||
        (typeof e.reason === "string" && e.reason) ||
        (typeof e.details === "string" && e.details) ||
        (err instanceof Error ? err.message : String(err));
      console.error("[send flow]", err);
      setError(msg);
    }
  }, []);

  return { open, status, progress, error, txHash, execute, reset };
}
