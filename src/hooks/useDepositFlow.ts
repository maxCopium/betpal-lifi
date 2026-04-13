"use client";

import { useState, useCallback } from "react";
import { authedFetch } from "@/lib/clientFetch";
import { toBaseUnits } from "@/lib/amounts";
export type SourceChoice = {
  label: string;
  chainId: number;
  token: `0x${string}`;
  decimals: number;
};

type QuoteResponse = {
  depositId: string;
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

type ConfirmResponse = {
  status: string;
  stake_status?: string | null;
};

/* Minimal Privy wallet interface — avoids importing the full SDK type. */
type Wallet = {
  address: string;
  walletClientType: string;
  switchChain: (chainId: number) => Promise<void>;
  getEthereumProvider: () => Promise<{
    request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  }>;
};

export type DepositFlowParams = {
  groupId: string;
  source: SourceChoice;
  amount: string;
  wallet: Wallet;
  betId?: string;
  outcome?: string;
};

export type DepositFlowState = {
  open: boolean;
  status: string;
  progress: number | undefined;
  error: string | null;
  stakeStatus: string | null;
  execute: (params: DepositFlowParams) => Promise<void>;
  reset: () => void;
};

export function useDepositFlow(): DepositFlowState {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState<number | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [stakeStatus, setStakeStatus] = useState<string | null>(null);

  const reset = useCallback(() => {
    setOpen(false);
    setStatus("");
    setProgress(undefined);
    setError(null);
    setStakeStatus(null);
  }, []);

  const execute = useCallback(async (params: DepositFlowParams) => {
    const { groupId, source, amount, wallet, betId, outcome } = params;
    setError(null);
    setStakeStatus(null);

    let fromAmount: string;
    try {
      fromAmount = toBaseUnits(amount, source.decimals);
      if (fromAmount === "0") throw new Error("amount must be > 0");
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    setOpen(true);
    setProgress(undefined);
    try {
      // Phase 1: get quote.
      setStatus("Quoting route via LI.FI Composer…");
      const quoteBody: Record<string, unknown> = {
        fromChain: source.chainId,
        fromToken: source.token,
        fromAmount,
      };
      if (betId && outcome) {
        quoteBody.betId = betId;
        quoteBody.outcome = outcome;
      }
      const quoteRes = await authedFetch<QuoteResponse>(
        `/api/groups/${groupId}/deposits`,
        { method: "POST", body: JSON.stringify(quoteBody) },
      );

      // Phase 2: switch chain + approve + sign.
      setStatus("Switching wallet to source chain…");
      try {
        await wallet.switchChain(source.chainId);
      } catch (err) {
        console.warn("switchChain failed (continuing):", err);
      }

      const provider = await wallet.getEthereumProvider();
      const NATIVE = "0x0000000000000000000000000000000000000000";
      const approvalAddress = quoteRes.quote.estimate.approvalAddress;

      // ERC-20 approval: check current allowance and approve if needed.
      if (
        approvalAddress &&
        source.token.toLowerCase() !== NATIVE
      ) {
        setStatus("Checking token allowance…");
        // ERC-20 allowance(owner, spender) selector = 0xdd62ed3e
        const allowanceData =
          "0xdd62ed3e" +
          wallet.address.slice(2).padStart(64, "0") +
          approvalAddress.slice(2).padStart(64, "0");
        const allowanceHex = (await provider.request({
          method: "eth_call",
          params: [{ to: source.token, data: allowanceData }, "latest"],
        })) as string;
        const allowance = BigInt(allowanceHex || "0x0");
        const needed = BigInt(fromAmount);
        if (allowance < needed) {
          setStatus("Approve token spend (1 of 2 signatures)…");
          // approve(spender, uint256.max) selector = 0x095ea7b3
          const approveData =
            "0x095ea7b3" +
            approvalAddress.slice(2).padStart(64, "0") +
            "f".repeat(64); // max uint256
          const approveTxHash = (await provider.request({
            method: "eth_sendTransaction",
            params: [{ from: wallet.address, to: source.token, data: approveData }],
          })) as string;
          // Wait for approval to be mined before sending the swap tx.
          setStatus("Waiting for approval confirmation…");
          let mined = false;
          for (let i = 0; i < 60 && !mined; i++) {
            const receipt = await provider.request({
              method: "eth_getTransactionReceipt",
              params: [approveTxHash],
            });
            if (receipt) { mined = true; break; }
            await new Promise((r) => setTimeout(r, 1500));
          }
          if (!mined) throw new Error("approval tx not confirmed after 90s");
        }
      }

      setStatus("Sign deposit transaction (2 of 2)…");
      const txParams = {
        from: wallet.address,
        to: quoteRes.quote.transactionRequest.to,
        data: quoteRes.quote.transactionRequest.data,
        value: quoteRes.quote.transactionRequest.value ?? "0x0",
      };
      const txHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [txParams],
      })) as string;

      setStatus("Reporting tx hash to BetPal…");
      await authedFetch(
        `/api/groups/${groupId}/deposits/${quoteRes.depositId}`,
        { method: "PATCH", body: JSON.stringify({ txHash }) },
      );

      // Phase 3: poll confirm.
      const start = Date.now();
      const timeoutMs = 5 * 60 * 1000;
      let done = false;
      while (!done) {
        const elapsed = Date.now() - start;
        const pct = Math.min(95, Math.round((elapsed / timeoutMs) * 95));
        setProgress(pct);
        setStatus("Bridging via LI.FI Composer…");
        const res = await authedFetch<ConfirmResponse>(
          `/api/groups/${groupId}/deposits/${quoteRes.depositId}/confirm`,
          { method: "POST" },
        );
        if (res.status === "completed") {
          setProgress(100);
          if (res.stake_status === "created") {
            setStatus("Deposit confirmed & bet placed!");
          } else if (res.stake_status?.startsWith("skipped_")) {
            setStatus(`Deposit confirmed. Bet could not be placed (${res.stake_status}) — funds added to your balance.`);
          } else {
            setStatus("Funds delivered to group vault.");
          }
          setStakeStatus(res.stake_status ?? null);
          done = true;
          break;
        }
        if (res.status === "failed" || res.status === "reverted") {
          throw new Error(`deposit ${res.status}`);
        }
        if (elapsed >= timeoutMs) {
          throw new Error("deposit timed out — check the dashboard later");
        }
        await new Promise((r) => setTimeout(r, 4000));
      }
    } catch (err) {
      setStatus("Failed.");
      const e = err as Record<string, unknown>;
      // Privy/provider errors sometimes nest details in .details, .reason, or .shortMessage
      const msg =
        (typeof e.shortMessage === "string" && e.shortMessage) ||
        (typeof e.reason === "string" && e.reason) ||
        (typeof e.details === "string" && e.details) ||
        (err instanceof Error ? err.message : String(err));
      console.error("[deposit flow]", err);
      setError(msg);
    }
  }, []);

  return { open, status, progress, error, stakeStatus, execute, reset };
}
