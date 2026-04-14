import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for vault.ts business logic.
 *
 * Mocks: viem public client, groupWallet sign helpers, composer quote.
 * Tests the three redeem paths (existing-USDC shortcut, Composer,
 * direct ERC-4626 redeem) and the partial-redeem error handling.
 */

vi.mock("server-only", () => ({}));

// Mock viem public client
const mockReadContract = vi.fn();
const mockGetBalance = vi.fn().mockResolvedValue(BigInt(1_000_000_000_000_000)); // 0.001 ETH — plenty of gas
const mockWaitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "success" });
vi.mock("./viem", () => ({
  basePublicClient: () => ({
    readContract: mockReadContract,
    getBalance: mockGetBalance,
    waitForTransactionReceipt: mockWaitForTransactionReceipt,
  }),
}));

// Mock groupWallet
const mockSendGroupContractCall = vi.fn().mockResolvedValue("0xmockhash" as `0x${string}`);
const mockSendGroupTransaction = vi.fn().mockResolvedValue("0xmockhash" as `0x${string}`);
vi.mock("./groupWallet", () => ({
  sendGroupContractCall: (...args: any[]) => mockSendGroupContractCall(...args),
  sendGroupTransaction: (...args: any[]) => mockSendGroupTransaction(...args),
}));

// Mock composer — default: throw so tests fall through to direct redeem
const mockGetComposerReverseQuote = vi.fn().mockRejectedValue(new Error("no composer route"));
vi.mock("./composer", () => ({
  getComposerReverseQuote: (...args: any[]) => mockGetComposerReverseQuote(...args),
}));

import { getVaultBalanceCents, redeemFromVault, PartialRedeemError } from "./vault";
import { CENTS_TO_USDC_UNITS } from "./constants";

/**
 * Set up read-contract responses for the direct-redeem path (Path B).
 *
 *   1. convertToShares(usdcAmount)  — sharesNeeded
 *   2. balanceOf(groupWallet)       — sharesHeld (on vault)
 *   3. balanceOf(groupWallet)       — existingUsdc (on USDC, triggers Path 0 if >= usdcAmount)
 *   4. balanceOf(groupWallet)       — usdcBefore (Path B snapshot)
 *   5. balanceOf(groupWallet)       — usdcAfter (Path B after redeem)
 */
function setupDirectRedeemReads(opts: {
  sharesNeeded: bigint;
  sharesHeld: bigint;
  existingUsdc: bigint;
  usdcBefore: bigint;
  usdcAfter: bigint;
}) {
  mockReadContract.mockReset();
  mockReadContract
    .mockResolvedValueOnce(opts.sharesNeeded)
    .mockResolvedValueOnce(opts.sharesHeld)
    .mockResolvedValueOnce(opts.existingUsdc)
    .mockResolvedValueOnce(opts.usdcBefore)
    .mockResolvedValueOnce(opts.usdcAfter);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWaitForTransactionReceipt.mockResolvedValue({ status: "success" });
  mockGetComposerReverseQuote.mockRejectedValue(new Error("no composer route"));
});

describe("getVaultBalanceCents", () => {
  it("converts vault shares → assets → cents correctly", async () => {
    mockReadContract
      .mockResolvedValueOnce(BigInt(1000000)) // balanceOf → shares
      .mockResolvedValueOnce(BigInt(100_000_000)); // convertToAssets → 100 USDC

    const cents = await getVaultBalanceCents(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    );
    expect(cents).toBe(10_000);
  });

  it("returns null on read failure", async () => {
    mockReadContract.mockRejectedValueOnce(new Error("RPC down"));
    const cents = await getVaultBalanceCents(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    );
    expect(cents).toBeNull();
  });

  it("returns 0 cents for zero shares", async () => {
    mockReadContract
      .mockResolvedValueOnce(BigInt(0))
      .mockResolvedValueOnce(BigInt(0));

    const cents = await getVaultBalanceCents(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    );
    expect(cents).toBe(0);
  });
});

describe("redeemFromVault", () => {
  it("uses existing USDC directly (Path 0) when group wallet already holds enough", async () => {
    // 500 cents = 5_000_000 base units
    const amountCents = 500;
    const usdcAmount = BigInt(amountCents) * CENTS_TO_USDC_UNITS;

    mockReadContract
      .mockResolvedValueOnce(BigInt(1_000_000)) // convertToShares → sharesNeeded
      .mockResolvedValueOnce(BigInt(10_000_000)) // balanceOf vault → sharesHeld
      .mockResolvedValueOnce(usdcAmount + BigInt(1000)); // balanceOf USDC → existing covers it
    mockSendGroupContractCall.mockResolvedValueOnce("0xtransfer" as `0x${string}`);

    const result = await redeemFromVault(
      "privy-wallet-1",
      "0xvault",
      "0xwallet",
      amountCents,
      "0xrecipient",
    );

    // Only one call — just the transfer, no redeem.
    expect(mockSendGroupContractCall).toHaveBeenCalledTimes(1);
    expect(mockSendGroupContractCall.mock.calls[0][3]).toBe("transfer");
    expect(result.redeemTxHash).toBe("0xtransfer");
    expect(result.transferTxHash).toBe("0xtransfer");
  });

  it("falls back to direct redeem + transfer when Composer has no route and no existing USDC", async () => {
    const amountCents = 100;
    const usdcAmount = BigInt(amountCents) * CENTS_TO_USDC_UNITS; // 1_000_000

    setupDirectRedeemReads({
      sharesNeeded: BigInt(500_000),
      sharesHeld: BigInt(5_000_000),
      existingUsdc: BigInt(0),          // Path 0 skipped
      usdcBefore: BigInt(0),
      usdcAfter: usdcAmount,             // got full amount back
    });
    mockSendGroupContractCall
      .mockResolvedValueOnce("0xredeem" as `0x${string}`)
      .mockResolvedValueOnce("0xtransfer" as `0x${string}`);

    const result = await redeemFromVault(
      "privy-wallet-1",
      "0xvault",
      "0xwallet",
      amountCents,
      "0xrecipient",
    );

    expect(mockSendGroupContractCall.mock.calls[0][3]).toBe("redeem");
    expect(mockSendGroupContractCall.mock.calls[1][3]).toBe("transfer");
    expect(result.redeemTxHash).toBe("0xredeem");
    expect(result.transferTxHash).toBe("0xtransfer");
  });

  it("throws on insufficient gas", async () => {
    mockGetBalance.mockResolvedValueOnce(BigInt(100)); // nearly zero ETH

    await expect(
      redeemFromVault(
        "privy-wallet-1",
        "0xvault",
        "0xwallet",
        100,
        "0xrecipient",
      ),
    ).rejects.toThrow(/gas/);
  });

  it("throws PartialRedeemError when transfer fails after successful redeem", async () => {
    const amountCents = 100;
    const usdcAmount = BigInt(amountCents) * CENTS_TO_USDC_UNITS;

    setupDirectRedeemReads({
      sharesNeeded: BigInt(500_000),
      sharesHeld: BigInt(5_000_000),
      existingUsdc: BigInt(0),
      usdcBefore: BigInt(0),
      usdcAfter: usdcAmount,
    });
    mockSendGroupContractCall
      .mockResolvedValueOnce("0xredeem" as `0x${string}`)
      .mockRejectedValueOnce(new Error("transfer failed"))
      .mockRejectedValueOnce(new Error("transfer failed"));

    await expect(
      redeemFromVault(
        "privy-wallet-1",
        "0xvault",
        "0xwallet",
        amountCents,
        "0xrecipient",
      ),
    ).rejects.toThrow(PartialRedeemError);
  });

  it("retries transfer once on failure", async () => {
    const amountCents = 100;
    const usdcAmount = BigInt(amountCents) * CENTS_TO_USDC_UNITS;

    setupDirectRedeemReads({
      sharesNeeded: BigInt(500_000),
      sharesHeld: BigInt(5_000_000),
      existingUsdc: BigInt(0),
      usdcBefore: BigInt(0),
      usdcAfter: usdcAmount,
    });
    mockSendGroupContractCall
      .mockResolvedValueOnce("0xredeem" as `0x${string}`)
      .mockRejectedValueOnce(new Error("nonce too low"))
      .mockResolvedValueOnce("0xtransfer" as `0x${string}`);

    const result = await redeemFromVault(
      "privy-wallet-1",
      "0xvault",
      "0xwallet",
      amountCents,
      "0xrecipient",
    );

    expect(result.transferTxHash).toBe("0xtransfer");
    // redeem + failed transfer + successful retry
    expect(mockSendGroupContractCall).toHaveBeenCalledTimes(3);
  });
});
