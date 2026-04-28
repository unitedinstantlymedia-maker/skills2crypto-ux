// Registry of forbidden player wallets (oracle/deployer/platform).
// Enforced at the matchmaking entry points and inside the oracle as
// defense-in-depth. Addresses are derived from the server's own secrets;
// missing secrets are skipped with a warning (fail-open by design).

import { ethers } from "ethers";

type AssetGroup = "EVM" | "TRON" | "TON";

const FORBIDDEN: Record<AssetGroup, Set<string>> = {
  EVM: new Set(),
  TRON: new Set(),
  TON: new Set(),
};

let _initialized = false;
let _initPromise: Promise<void> | null = null;
let _initFailed = false;
let _initStartedAt = 0;
const REQUEST_INIT_WAIT_MS = 5000;

function normalizeEvm(addr: string): string {
  return addr.trim().toLowerCase();
}

function normalizeTron(addr: string): string {
  // Tron base58 addresses are case-sensitive — compare verbatim.
  return addr.trim();
}

async function normalizeTon(addr: string): Promise<string> {
  // TON addresses can appear in many forms (EQ-bounceable / UQ-non-bounceable
  // / 0:hex raw / testnet variants). All point to the same underlying
  // workchain+hash, so canonicalise via Address.parse().toRawString() before
  // comparing.
  try {
    const { Address } = await import("@ton/core");
    return Address.parse(addr.trim()).toRawString().toLowerCase();
  } catch {
    return addr.trim().toLowerCase();
  }
}

async function deriveEvmAddresses(): Promise<string[]> {
  const out: string[] = [];

  for (const envName of ["ORACLE_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"] as const) {
    const pk = process.env[envName];
    if (!pk) continue;
    try {
      // Tolerate keys with or without 0x prefix.
      const hex = pk.startsWith("0x") ? pk : `0x${pk}`;
      const w = new ethers.Wallet(hex);
      out.push(normalizeEvm(w.address));
    } catch (e: any) {
      console.warn(`[systemAddresses] Could not derive EVM address from ${envName}: ${e?.message || e}`);
    }
  }

  // Platform / cold wallets (BSC and ETH share the same default deploy address).
  // The defaults match the values currently deployed in the V2 escrow
  // contracts; if the cold wallet is ever rotated, the corresponding env var
  // MUST be set or the blacklist will protect the obsolete address rather
  // than the live one. Warn loudly when the default is used so operators
  // notice during deployment.
  const DEFAULT_PW = "0x7F8Bc18A773f101194071aA559d15d2a59bf6832";
  for (const envName of ["BSC_PLATFORM_WALLET", "ETH_PLATFORM_WALLET"] as const) {
    const explicit = process.env[envName];
    const v = explicit || DEFAULT_PW;
    if (!explicit) {
      console.warn(
        `[systemAddresses] ${envName} is not set — using built-in default ${DEFAULT_PW}. Set the env var explicitly in production.`
      );
    }
    if (ethers.isAddress(v)) out.push(normalizeEvm(v));
  }

  return out;
}

async function deriveTronAddresses(): Promise<string[]> {
  const out: string[] = [];

  // Oracle (Tron uses the same ORACLE_PRIVATE_KEY hex as EVM, just resolved
  // through a TronWeb to derive the base58 form).
  const pk = (process.env.ORACLE_PRIVATE_KEY || "").replace(/^0x/, "");
  if (pk) {
    try {
      const { TronWeb } = await import("tronweb");
      const tw = new TronWeb({
        fullHost: process.env.TRON_RPC_URL || "https://api.trongrid.io",
        privateKey: pk,
      });
      const derived = tw.address.fromPrivateKey(pk);
      if (derived && typeof derived === "string") out.push(normalizeTron(derived));
    } catch (e: any) {
      console.warn(`[systemAddresses] Could not derive Tron address from ORACLE_PRIVATE_KEY: ${e?.message || e}`);
    }
  }

  // Platform wallet (matches the default in tronOracle.ts).
  const tronPw = process.env.TRON_PLATFORM_WALLET || "TEWL8GXDvjizmvtZ2pWSzz39AaFKMP5aqq";
  if (tronPw) out.push(normalizeTron(tronPw));

  return out;
}

async function deriveTonAddresses(): Promise<string[]> {
  const out: string[] = [];

  let mnemonicToPrivateKey: any;
  let WalletContractV4: any;
  try {
    ({ mnemonicToPrivateKey } = await import("@ton/crypto"));
    ({ WalletContractV4 } = await import("@ton/ton"));
  } catch (e: any) {
    console.warn(`[systemAddresses] @ton libraries unavailable: ${e?.message || e}`);
    return out;
  }

  for (const envName of ["TON_ORACLE_MNEMONIC", "TON_DEPLOYER_MNEMONIC"] as const) {
    const phraseRaw = process.env[envName];
    if (!phraseRaw) continue;
    const phrase = phraseRaw.trim().split(/\s+/);
    if (phrase.length !== 24) {
      console.warn(`[systemAddresses] ${envName} is not 24 words (got ${phrase.length}); skipping`);
      continue;
    }
    try {
      const key = await mnemonicToPrivateKey(phrase);
      const wallet = WalletContractV4.create({ workchain: 0, publicKey: key.publicKey });
      out.push(await normalizeTon(wallet.address.toString()));
    } catch (e: any) {
      console.warn(`[systemAddresses] Could not derive TON address from ${envName}: ${e?.message || e}`);
    }
  }

  const tonPw = process.env.TON_PLATFORM_WALLET;
  if (tonPw) {
    try {
      out.push(await normalizeTon(tonPw));
    } catch (e: any) {
      console.warn(`[systemAddresses] Could not normalize TON_PLATFORM_WALLET: ${e?.message || e}`);
    }
  }

  return out;
}

async function doInit(): Promise<void> {
  // Each derivation has its own try/catch and returns a (possibly empty)
  // array, but we wrap each call defensively so an unexpected reject can
  // never leave `_initialized` permanently false. If we don't guarantee
  // that, every subsequent `await initSystemAddresses()` would re-throw
  // through `checkSystemAddress` and turn matchmaking into a hard 500 —
  // i.e. fail-closed instead of the fail-open behaviour we want.
  try {
    const [evm, tron, ton] = await Promise.all([
      deriveEvmAddresses().catch((e: any) => {
        console.warn(`[systemAddresses] EVM derivation failed: ${e?.message || e}`);
        return [] as string[];
      }),
      deriveTronAddresses().catch((e: any) => {
        console.warn(`[systemAddresses] Tron derivation failed: ${e?.message || e}`);
        return [] as string[];
      }),
      deriveTonAddresses().catch((e: any) => {
        console.warn(`[systemAddresses] TON derivation failed: ${e?.message || e}`);
        return [] as string[];
      }),
    ]);

    evm.forEach((a) => FORBIDDEN.EVM.add(a));
    tron.forEach((a) => FORBIDDEN.TRON.add(a));
    ton.forEach((a) => FORBIDDEN.TON.add(a));

    console.log(
      `[systemAddresses] Loaded forbidden wallet list — EVM: ${FORBIDDEN.EVM.size}, Tron: ${FORBIDDEN.TRON.size}, TON: ${FORBIDDEN.TON.size}`
    );
  } catch (e: any) {
    // Should be unreachable given the per-deriver catches above, but keep
    // it as the final guarantee that init always completes.
    console.error(`[systemAddresses] init failed unexpectedly: ${e?.message || e}`);
    _initFailed = true;
  } finally {
    _initialized = true;
  }
}

export function initSystemAddresses(): Promise<void> {
  if (_initialized) return Promise.resolve();
  if (!_initPromise) {
    _initStartedAt = Date.now();
    _initPromise = doInit();
  }
  return _initPromise;
}

/**
 * Block-until-ready helper for request handlers. If init is still in
 * flight, awaits up to REQUEST_INIT_WAIT_MS. Returns true if the
 * registry is loaded (even if some derivations failed — the partial
 * blacklist is better than none); returns false only if the wait
 * timed out without init completing. Callers should reject the
 * request with 503 in that rare case rather than fail open.
 */
export async function waitForSystemAddressesReady(): Promise<boolean> {
  if (_initialized) return true;
  if (!_initPromise) initSystemAddresses();
  try {
    await Promise.race([
      _initPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("init_timeout")), REQUEST_INIT_WAIT_MS)
      ),
    ]);
  } catch {
    return _initialized;
  }
  return _initialized;
}

/**
 * For diagnostics + the /api/health/oracles endpoint.
 */
export function getSystemAddressesStatus() {
  return {
    initialized: _initialized,
    initFailed: _initFailed,
    initStartedAt: _initStartedAt || null,
    counts: {
      EVM: FORBIDDEN.EVM.size,
      TRON: FORBIDDEN.TRON.size,
      TON: FORBIDDEN.TON.size,
    },
  };
}

function assetGroup(asset: string): AssetGroup | null {
  if (asset === "BNB" || asset === "ETH") return "EVM";
  if (asset === "USDT") return "TRON";
  if (asset === "TON") return "TON";
  return null;
}

/**
 * Async system-address check for any asset. Used at the matchmaking layer
 * (A) where awaiting an extra microtask is harmless. Returns `{ ok: false }`
 * with a stable reason code if `walletAddress` matches a forbidden entry.
 */
export async function checkSystemAddress(
  asset: string,
  walletAddress: string | null | undefined
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!walletAddress) return { ok: true };
  // Block-until-ready (with timeout). If we never finish initialising,
  // tell the caller — the request handler decides whether to return
  // 503 or proceed. We deliberately don't fall through to the empty
  // FORBIDDEN sets, since that's the cold-start fail-open hole.
  const ready = await waitForSystemAddressesReady();
  if (!ready) {
    return { ok: false, reason: "system_addresses_not_ready" };
  }
  const group = assetGroup(asset);
  if (!group) return { ok: true };

  let normalized: string;
  if (group === "EVM") normalized = normalizeEvm(walletAddress);
  else if (group === "TRON") normalized = normalizeTron(walletAddress);
  else normalized = await normalizeTon(walletAddress);

  if (FORBIDDEN[group].has(normalized)) {
    return { ok: false, reason: "wallet_is_system_address" };
  }
  return { ok: true };
}

/**
 * Sync EVM-only check. Used at the oracle-signing layer (B) where the call
 * site is itself sync up to the moment it would issue the signature, and
 * where TON/Tron are not relevant (TON has no MatchAuth path; Tron uses a
 * different deposit-auth shape that gets its own check). Requires
 * `initSystemAddresses()` to have already resolved — call it once at
 * startup. Returns `null` if init has not yet completed (the matchmaking
 * layer is the primary defence; failing closed here would risk blocking
 * legitimate matches during a cold start).
 */
export function isForbiddenEvmAddressSync(addr: string): boolean | null {
  if (!_initialized) return null;
  return FORBIDDEN.EVM.has(normalizeEvm(addr));
}

export function isForbiddenTronAddressSync(addr: string): boolean | null {
  if (!_initialized) return null;
  return FORBIDDEN.TRON.has(normalizeTron(addr));
}

/**
 * Compare two wallet addresses for equality, with chain-appropriate
 * normalisation (lowercase for EVM, raw for TON, verbatim for Tron).
 * Used by matchmaking to block "same wallet on two browsers" matches even
 * when the two requests arrive on different socket IDs.
 */
export async function walletAddressesEqual(
  asset: string,
  a: string | null | undefined,
  b: string | null | undefined
): Promise<boolean> {
  if (!a || !b) return false;
  const group = assetGroup(asset);
  if (!group) return a.trim() === b.trim();

  if (group === "EVM") return normalizeEvm(a) === normalizeEvm(b);
  if (group === "TRON") return normalizeTron(a) === normalizeTron(b);
  // TON
  const [na, nb] = await Promise.all([normalizeTon(a), normalizeTon(b)]);
  return na === nb;
}
