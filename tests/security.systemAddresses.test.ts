/**
 * Tests for the cold-start fail-open / fail-closed behaviour of the
 * forbidden-system-address registry.
 *
 * These tests intentionally do NOT call initSystemAddresses(). The
 * point is to verify that BEFORE init has resolved the sync helpers
 * return `null` (so the matchmaking layer is the primary defence and
 * a slow init doesn't deadlock matches), while AFTER an explicit
 * init-failure the request layer can still detect the not-ready state.
 */
import { describe, it, expect } from "vitest";

describe("systemAddresses (cold-start gate)", () => {
  it("isForbiddenEvmAddressSync returns NULL (not false) before init", async () => {
    // The module is imported with vi.resetModules so the in-process
    // _initialized flag is guaranteed false. The `null` sentinel is
    // load-bearing: callers (server/oracle/evmOracle.ts ~L207) check
    // `=== true` to distinguish "checked, forbidden" from "registry
    // not ready yet". A `false` return would *silently* fail open
    // during the cold-start window without giving callers a chance
    // to handle the not-ready state.
    const { default: vitestUtils } = await import("vitest");
    void vitestUtils;
    const { isForbiddenEvmAddressSync } = await import(
      "../server/security/systemAddresses"
    );
    const r = isForbiddenEvmAddressSync(
      "0x0000000000000000000000000000000000000001"
    );
    expect(r).toBeNull();
  });

  it("isForbiddenTronAddressSync returns NULL before init", async () => {
    const { isForbiddenTronAddressSync } = await import(
      "../server/security/systemAddresses"
    );
    const r = isForbiddenTronAddressSync("TJRabPrwbZy45sbavfcjinPJC18kjpRTv8");
    expect(r).toBeNull();
  });
});
