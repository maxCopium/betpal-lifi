import { describe, it, expect } from "vitest";
import { encodeFunctionData } from "viem";
import { ERC4626_ABI, ERC20_ABI } from "./abis";

describe("ERC4626_ABI", () => {
  it("contains all required vault functions", () => {
    const names = ERC4626_ABI.map((f) => f.name);
    expect(names).toContain("balanceOf");
    expect(names).toContain("convertToAssets");
    expect(names).toContain("convertToShares");
    expect(names).toContain("deposit");
    expect(names).toContain("redeem");
  });

  it("encodes a deposit call via viem", () => {
    const data = encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: "deposit",
      args: [1000000n, "0x0000000000000000000000000000000000000001"],
    });
    expect(data).toMatch(/^0x/);
  });

  it("encodes a redeem call via viem", () => {
    const data = encodeFunctionData({
      abi: ERC4626_ABI,
      functionName: "redeem",
      args: [
        500000n,
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
      ],
    });
    expect(data).toMatch(/^0x/);
  });
});

describe("ERC20_ABI", () => {
  it("contains transfer, approve, balanceOf", () => {
    const names = ERC20_ABI.map((f) => f.name);
    expect(names).toContain("transfer");
    expect(names).toContain("approve");
    expect(names).toContain("balanceOf");
  });

  it("encodes a transfer call via viem", () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: ["0x0000000000000000000000000000000000000001", 1000000n],
    });
    expect(data).toMatch(/^0x/);
  });

  it("encodes an approve call via viem", () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: ["0x0000000000000000000000000000000000000001", 1000000n],
    });
    expect(data).toMatch(/^0x/);
  });
});
