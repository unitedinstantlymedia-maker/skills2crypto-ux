/**
 * Invariant: the off-chain oracle pause must NOT gate settlement.
 *
 * The evm/tron oracles call `isOraclePaused` from `signMatchAuth`
 * (deposit-side) but NOT from `signMatchOutcome` (settle-side). This
 * test grep-asserts that property at the source level so a future
 * refactor cannot accidentally add the guard to the settle path —
 * which would lock funds in escrow during a pause.
 *
 * Source-level grep (vs runtime test) is intentional: a runtime test
 * would have to mock the entire ethers/tronWeb chain plumbing, while
 * the actual concern is "did someone copy-paste the deposit guard
 * into the settle function". A grep nails that exact regression.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

function loadSrc(rel: string): string {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

describe("oracle pause invariant", () => {
  const evm = loadSrc("server/oracle/evmOracle.ts");
  const tron = loadSrc("server/oracle/tronOracle.ts");

  it("evmOracle.signMatchAuth gates on isOraclePaused", () => {
    const fn = evm.split("function signMatchAuth")[1]?.split("function signMatchOutcome")[0] ?? "";
    expect(fn).toMatch(/isOraclePaused/);
    expect(fn).toMatch(/ORACLE_PAUSED/);
  });

  it("evmOracle.signMatchOutcome does NOT gate on isOraclePaused (settlement must always work)", () => {
    const fn = evm.split("function signMatchOutcome")[1]?.split("\n  return ")[0] ?? "";
    expect(fn).not.toMatch(/isOraclePaused/);
  });

  it("tronOracle deposit path gates on isOraclePaused", () => {
    expect(tron).toMatch(/isOraclePaused/);
  });

  it("tronOracle.signMatchOutcome does NOT gate on isOraclePaused (settlement must always work)", () => {
    // Slice from `async function signMatchOutcome(` to the next
    // top-level `async function` (or end of file) and assert the
    // pause check is absent. Tron's settle path is named
    // `signMatchOutcome` to mirror EVM's terminology.
    const start = tron.indexOf("async function signMatchOutcome(");
    expect(start, "signMatchOutcome not found in tronOracle.ts").toBeGreaterThan(-1);
    const after = tron.slice(start + "async function signMatchOutcome(".length);
    const nextFnIdx = after.search(/\n\s*async function /);
    const slice = nextFnIdx === -1 ? after : after.slice(0, nextFnIdx);
    expect(slice).not.toMatch(/isOraclePaused/);
  });

  it("source comments document the rationale", () => {
    expect(evm).toMatch(/[Ss]ettle/);
    expect(evm).toMatch(/in-?flight/i);
  });
});
