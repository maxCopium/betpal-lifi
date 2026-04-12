import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for vault.ts business logic.
 *
 * Mocks: viem public client, groupWallet contract calls.
 * Tests conversion math, error handling, and call sequencing.
 */

vi.mock("server-only", () => ({}));

// Mock viem public client
const mockReadContract = vi.fn();
const mockGetBalance = vi.fn().mockResolvedValue(BigInt(1_000_000_000_000_000)); // 0.001 ETH — plenty of gas
const mockWaitForTransactionReceipt = vi.fn().mockResolvedValue({});
vi.mock("./viem", () => ({
  basePublicClient: () => ({
    readContract: mockReadContract,
    getBalance: mockGetBalance,
    waitForTransactionReceipt: mockWaitForTransactionReceipt,
  }),
}));

// Mock groupWallet
const mockSendGroupContractCall = vi.fn().mockResolvedValue("0xmockhash" as `0x${string}`);
vi.mock("./groupWallet", () => ({
  sendGroupContractCall: (...args: any[]) => mockSendGroupContractCall(...args),
}));

import { getVaultBalanceCents, redeemFromVault, PartialRedeemError } from "./vault";
import { CENTS_TO_USDC_UNITS } from "./constants";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getVaultBalanceCents", () => {
  it("converts vault shares → assets → cents correctly", async () => {
    // 100 USDC = 100_000_000 base units = 10000 cents
    mockReadContract
      .mockResolvedValueOnce(BigInt(1000000)) // balanceOf → shares
      .mockResolvedValueOnce(BigInt(100_000_000)); // convertToAssets → 100 USDC

    const cents = await getVaultBalanceCents(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    );
    // 100_000_000 / 10_000 = 10_000 cents = $100
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
      .mockResolvedValueOnce(BigInt(0)) // balanceOf → 0 shares
      .mockResolvedValueOnce(BigInt(0)); // convertToAssets → 0

    const cents = await getVaultBalanceCents(
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
    );
    expect(cents).toBe(0);
  });
});

describe("redeemFromVault", () => {
  it("converts cents to USDC base units correctly", async () => {
    // 500 cents = $5.00 = 5_000_000 USDC base units
    const expectedUsdc = BigInt(500) * CENTS_TO_USDC_UNITS; // 5_000_000n
    expect(expectedUsdc).toBe(BigInt(5_000_000));

    mockReadContract.mockResolvedValueOnce(BigInt(5_000_000)); // convertToShares
    mockSendGroupContractCall.mockResolvedValue("0xmockhash" as `0x${string}`);

    const result = await redeemFromVault(
      "privy-wallet-1",
      "0xvault",
      "0xwallet",
      500,
      "0xrecipient",
    );

    expect(result.redeemTxHash).toBe("0xmockhash");
    expect(result.transferTxHash).toBe("0xmockhash");
  });

  it("throws when shares needed is 0", async () => {
    mockReadContract.mockResolvedValueOnce(BigInt(0)); // convertToShares → 0

    await expect(
      redeemFromVault(
        "privy-wallet-1",
        "0xvault",
        "0xwallet",
        1, // 1 cent
        "0xrecipient",
      ),
    ).rejects.toThrow("converts to 0 vault shares");
  });

  it("calls redeem then transfer in sequence", async () => {
    mockReadContract.mockResolvedValueOnce(BigInt(1000)); // convertToShares
    mockSendGroupContractCall
      .mockResolvedValueOnce("0xredeem" as `0x${string}`)
      .mockResolvedValueOnce("0xtransfer" as `0x${string}`);

    const result = await redeemFromVault(
      "privy-wallet-1",
      "0xvault",
      "0xwallet",
      100,
      "0xrecipient",
    );

    // First call is redeem, second is transfer
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
    ).rejects.toThrow("insufficient gas");
  });

  it("throws PartialRedeemError when transfer fails after redeem", async () => {
    mockReadContract.mockResolvedValueOnce(BigInt(1000)); // convertToShares
    mockSendGroupContractCall
      .mockResolvedValueOnce("0xredeem" as `0x${string}`) // redeem succeeds
      .mockRejectedValueOnce(new Error("transfer failed")) // first transfer fails
      .mockRejectedValueOnce(new Error("transfer failed")); // retry also fails

    await expect(
      redeemFromVault(
        "privy-wallet-1",
        "0xvault",
        "0xwallet",
        100,
        "0xrecipient",
      ),
    ).rejects.toThrow(PartialRedeemError);
  });

  it("retries transfer once on failure", async () => {
    mockReadContract.mockResolvedValueOnce(BigInt(1000)); // convertToShares
    mockSendGroupContractCall
      .mockResolvedValueOnce("0xredeem" as `0x${string}`) // redeem
      .mockRejectedValueOnce(new Error("nonce too low")) // first transfer fails
      .mockResolvedValueOnce("0xtransfer" as `0x${string}`); // retry succeeds

    const result = await redeemFromVault(
      "privy-wallet-1",
      "0xvault",
      "0xwallet",
      100,
      "0xrecipient",
    );

    expect(result.transferTxHash).toBe("0xtransfer");
    // 3 calls: redeem + failed transfer + successful retry
    expect(mockSendGroupContractCall).toHaveBeenCalledTimes(3);
  });
});
