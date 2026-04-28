import { describe, it, expect } from "vitest";
import { isValidWalletShape } from "../shared/walletShape";

describe("isValidWalletShape", () => {
  it("accepts a checksummed EVM address for BNB and ETH", () => {
    const a = "0x1111111111111111111111111111111111111111";
    expect(isValidWalletShape("BNB", a)).toBe(true);
    expect(isValidWalletShape("ETH", a)).toBe(true);
  });

  it("rejects a Tron address presented under an EVM asset", () => {
    expect(
      isValidWalletShape("BNB", "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8")
    ).toBe(false);
    expect(
      isValidWalletShape("ETH", "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8")
    ).toBe(false);
  });

  it("accepts a Tron base58 address for USDT", () => {
    expect(
      isValidWalletShape("USDT", "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8")
    ).toBe(true);
  });

  it("rejects an EVM-shaped address for USDT (Tron) — would silently break deposit", () => {
    expect(
      isValidWalletShape("USDT", "0x1111111111111111111111111111111111111111")
    ).toBe(false);
  });

  it("rejects an EVM address with non-hex chars", () => {
    expect(
      isValidWalletShape("ETH", "0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ")
    ).toBe(false);
  });

  it("rejects an EVM address with the wrong length", () => {
    expect(isValidWalletShape("BNB", "0x123")).toBe(false);
    expect(
      isValidWalletShape("BNB", "0x111111111111111111111111111111111111111111")
    ).toBe(false);
  });

  it("rejects empty and non-string inputs", () => {
    expect(isValidWalletShape("BNB", "")).toBe(false);
    // @ts-expect-error: intentional bad input
    expect(isValidWalletShape("BNB", undefined)).toBe(false);
    // @ts-expect-error: intentional bad input
    expect(isValidWalletShape("BNB", 12345)).toBe(false);
  });

  it("accepts non-empty TON address forms (canonicalisation happens downstream)", () => {
    expect(
      isValidWalletShape(
        "TON",
        "EQDrLahbiSZBdQUm84O3GUycCcCmQ9_w-EeP9p9aZ7JQAAAA"
      )
    ).toBe(true);
    expect(
      isValidWalletShape(
        "TON",
        "0:8b3a8f6fa05f99ad4c9c7e84d3f49ae6c5cb1fffe0fe7dca8b6493c6720efabe"
      )
    ).toBe(true);
  });

  it("rejects unknown asset codes", () => {
    expect(
      isValidWalletShape("DOGE" as any, "0x1111111111111111111111111111111111111111")
    ).toBe(false);
  });
});
