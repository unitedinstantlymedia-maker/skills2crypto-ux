/**
 * Source-level guardrail check for the three transfer-ownership
 * scripts. We do NOT execute hardhat / tronweb here — these tests
 * just verify the scripts contain the safety checks the audit
 * required, so a careless edit (e.g. dropping the CONFIRM gate)
 * shows up as a failing test rather than a quiet supply-chain risk.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");
const SCRIPTS = [
  "scripts/transfer-ownership-bsc.cjs",
  "scripts/transfer-ownership-eth.cjs",
  "scripts/transfer-ownership-tron.cjs",
];

describe("transfer-ownership scripts", () => {
  for (const rel of SCRIPTS) {
    describe(rel, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");

      it("requires CONFIRM=YES before broadcasting", () => {
        expect(src).toMatch(/CONFIRM\s*===?\s*['"]YES['"]/);
        expect(src).toMatch(/DRY-RUN/);
      });

      it("refuses if NEW_OWNER equals current owner", () => {
        // EVM scripts use .toLowerCase(); Tron uses verbatim base58.
        expect(src.toLowerCase()).toMatch(/(currentowner|current owner)/);
        expect(src).toMatch(/nothing to do|aborting|refusing/i);
      });

      it("refuses if NEW_OWNER equals oracle or platform wallet", () => {
        expect(src).toMatch(/oracle/);
        expect(src).toMatch(/platformWallet|platform wallet/);
      });

      it("requires NEW_OWNER env var", () => {
        expect(src).toMatch(/NEW_OWNER is required/);
      });

      it("prints a pre-flight summary including the new owner", () => {
        expect(src).toMatch(/(New owner|new owner)/);
      });
    });
  }
});
