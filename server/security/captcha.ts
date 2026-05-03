// Anti-cheat L1 — Slider/puzzle captcha at first deposit.
//
// One-time-per-wallet proof-of-humanity gate. The user drags a small
// puzzle piece into a gap on a background image; the slot position is
// verified server-side with a small tolerance plus a basic
// motion-trajectory sanity check (real human drags are not perfectly
// linear, do not finish in <100 ms, and have varying velocity).
//
// State is held in Upstash Redis so the gate works across replicas:
//   - captcha:challenge:<id>      — pending challenge truth (5 min TTL)
//   - captcha-passed:<wallet>     — verified flag (long TTL)
//   - captcha:fails:<wallet>      — sliding fail counter
//   - captcha:cooldown:<wallet>   — 15-min cooldown after N fails
//
// All wallet keys are lowercased so checksummed and lowercased
// addresses share state.

import type { SetCommandOptions } from "@upstash/redis";
import { redis } from "../redis";
import { randomBytes, createHash } from "crypto";

// --- env-tunable knobs --------------------------------------------------

const DEFAULT_CHALLENGE_TTL_SEC = 5 * 60;
const DEFAULT_VERIFIED_TTL_SEC = 365 * 24 * 60 * 60; // 1 year
const DEFAULT_FAIL_THRESHOLD = 5;
const DEFAULT_FAIL_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_TOLERANCE_PX = 4;
const DEFAULT_MIN_SAMPLES = 6;
const DEFAULT_MIN_DURATION_MS = 150;

export function getCaptchaFailThreshold(): number {
  const raw = process.env.CAPTCHA_FAIL_THRESHOLD;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FAIL_THRESHOLD;
}

export function getCaptchaFailCooldownMs(): number {
  const raw = process.env.CAPTCHA_FAIL_COOLDOWN_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FAIL_COOLDOWN_MS;
}

export function getCaptchaToleranceMs(): number {
  return DEFAULT_MIN_DURATION_MS;
}

export function getCaptchaTolerancePx(): number {
  const raw = process.env.CAPTCHA_TOLERANCE_PX;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOLERANCE_PX;
}

// --- key helpers --------------------------------------------------------

function challengeKey(id: string): string {
  return `captcha:challenge:${id}`;
}
function verifiedKey(wallet: string): string {
  return `captcha-passed:${wallet.toLowerCase()}`;
}
function failsKey(wallet: string): string {
  return `captcha:fails:${wallet.toLowerCase()}`;
}
function cooldownKey(wallet: string): string {
  return `captcha:cooldown:${wallet.toLowerCase()}`;
}

// --- canvas constants ---------------------------------------------------

const TRACK_WIDTH = 280;
const TRACK_HEIGHT = 160;
const PIECE_SIZE = 40;
// Piece can land anywhere in the track except too close to either edge,
// so the gap is always reachable but not trivially "always at x=0".
const MIN_GAP_X = PIECE_SIZE + 8;
const MAX_GAP_X = TRACK_WIDTH - PIECE_SIZE - 8;

// --- seeded RNG (mulberry32) -------------------------------------------
// Deterministic given the same seed so tests can assert exact output.

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// --- SVG generation -----------------------------------------------------

// Puzzle-piece silhouette: 40x40 box with a circular tab on the right
// side. Used both for the background cutout (drawn slightly darker) and
// the loose piece the user drags.
function piecePath(): string {
  // Square with a small bump on the right edge — cheap-to-render and
  // unmistakable as a puzzle piece on a phone screen.
  return [
    "M 0 0",
    "H 30",
    "C 30 8, 40 8, 40 16",
    "C 40 24, 30 24, 30 32",
    "V 40",
    "H 0",
    "Z",
  ].join(" ");
}

function backgroundSvg(seed: number, gapX: number, gapY: number): string {
  const rand = mulberry32(seed);
  const hueA = Math.floor(rand() * 360);
  const hueB = (hueA + 60 + Math.floor(rand() * 120)) % 360;
  const circles: string[] = [];
  for (let i = 0; i < 3; i++) {
    const cx = Math.floor(rand() * TRACK_WIDTH);
    const cy = Math.floor(rand() * TRACK_HEIGHT);
    const r = 24 + Math.floor(rand() * 36);
    const h = Math.floor(rand() * 360);
    circles.push(
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${h},60%,55%)" opacity="0.45"/>`
    );
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TRACK_WIDTH}" height="${TRACK_HEIGHT}" viewBox="0 0 ${TRACK_WIDTH} ${TRACK_HEIGHT}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">`,
    `<stop offset="0%" stop-color="hsl(${hueA},65%,45%)"/>`,
    `<stop offset="100%" stop-color="hsl(${hueB},65%,30%)"/>`,
    `</linearGradient></defs>`,
    `<rect width="${TRACK_WIDTH}" height="${TRACK_HEIGHT}" fill="url(#g)"/>`,
    circles.join(""),
    // Cutout silhouette drawn darker so the gap is visible.
    `<g transform="translate(${gapX},${gapY})">`,
    `<path d="${piecePath()}" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.4)" stroke-width="1"/>`,
    `</g>`,
    `</svg>`,
  ].join("");
}

function pieceSvg(seed: number): string {
  // Loose piece — same silhouette filled with a contrasting solid so
  // the user can see what they're dragging on any background.
  const rand = mulberry32(seed ^ 0x9e3779b9);
  const hue = Math.floor(rand() * 360);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PIECE_SIZE}" height="${PIECE_SIZE}" viewBox="0 0 ${PIECE_SIZE} ${PIECE_SIZE}">`,
    `<path d="${piecePath()}" fill="hsl(${hue},75%,60%)" stroke="rgba(0,0,0,0.55)" stroke-width="1.5"/>`,
    `</svg>`,
  ].join("");
}

function svgToDataUrl(svg: string): string {
  const b64 = Buffer.from(svg, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

// --- public types -------------------------------------------------------

export interface ChallengePayload {
  challengeId: string;
  backgroundImageDataUrl: string;
  pieceImageDataUrl: string;
  pieceY: number;
  pieceSize: number;
  trackHeight: number;
  trackWidth: number;
}

interface StoredChallenge {
  wallet: string;
  gapX: number;
  pieceY: number;
  seed: number;
  createdAt: number;
}

export interface MotionSample {
  t: number; // ms timestamp (any monotonic origin — only deltas matter)
  x: number; // px relative to track start
}

export interface VerifyParams {
  challengeId: string;
  slotX: number;
  motionSamples: MotionSample[];
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailureReason };

export type VerifyFailureReason =
  | "challenge_not_found"
  | "slot_mismatch"
  | "motion_too_few_samples"
  | "motion_too_fast"
  | "motion_perfectly_linear";

// --- generation ---------------------------------------------------------

export interface GenerateChallengeOptions {
  wallet: string;
  // Optional override for deterministic tests.
  seed?: number;
  challengeId?: string;
  ttlSec?: number;
}

export async function generateChallenge(
  opts: GenerateChallengeOptions
): Promise<ChallengePayload> {
  const wallet = (opts.wallet || "").toLowerCase();
  if (!wallet) throw new Error("wallet is required");
  const seed =
    typeof opts.seed === "number"
      ? opts.seed >>> 0
      : randomBytes(4).readUInt32BE(0);
  const rand = mulberry32(seed ^ 0x12345678);
  const gapX =
    MIN_GAP_X + Math.floor(rand() * (MAX_GAP_X - MIN_GAP_X + 1));
  // Piece Y stays roughly centered vertically; small jitter so it isn't
  // identical every time but the user only ever drags horizontally.
  const pieceY =
    Math.floor(TRACK_HEIGHT / 2 - PIECE_SIZE / 2 + (rand() * 16 - 8));
  const challengeId = opts.challengeId || randomBytes(12).toString("hex");

  const stored: StoredChallenge = {
    wallet,
    gapX,
    pieceY,
    seed,
    createdAt: Date.now(),
  };

  const ttl = opts.ttlSec ?? DEFAULT_CHALLENGE_TTL_SEC;
  try {
    const setOpts: SetCommandOptions = { ex: ttl };
    await redis.set(challengeKey(challengeId), JSON.stringify(stored), setOpts);
  } catch (e: any) {
    console.warn(`[captcha] redis set failed: ${e?.message || e}`);
    throw new Error("captcha_storage_unavailable");
  }

  return {
    challengeId,
    backgroundImageDataUrl: svgToDataUrl(backgroundSvg(seed, gapX, pieceY)),
    pieceImageDataUrl: svgToDataUrl(pieceSvg(seed)),
    pieceY,
    pieceSize: PIECE_SIZE,
    trackHeight: TRACK_HEIGHT,
    trackWidth: TRACK_WIDTH,
  };
}

// --- verification -------------------------------------------------------

function checkMotionSanity(
  samples: MotionSample[]
): { ok: true } | { ok: false; reason: VerifyFailureReason } {
  if (!Array.isArray(samples) || samples.length < DEFAULT_MIN_SAMPLES) {
    return { ok: false, reason: "motion_too_few_samples" };
  }
  const span = samples[samples.length - 1].t - samples[0].t;
  if (!Number.isFinite(span) || span < DEFAULT_MIN_DURATION_MS) {
    return { ok: false, reason: "motion_too_fast" };
  }
  // Compute per-step velocities; reject if every step has the EXACT
  // same delta-x (perfectly linear → almost certainly scripted).
  const deltas: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt <= 0) continue;
    deltas.push((samples[i].x - samples[i - 1].x) / dt);
  }
  if (deltas.length < 2) {
    return { ok: false, reason: "motion_too_few_samples" };
  }
  // Real drags wobble AND slow down somewhere along the way (humans
  // never accelerate monotonically over a 200 ms drag — they ease in
  // and ease out around the gap). We require BOTH:
  //   (a) at least one consecutive velocity pair that differs beyond a
  //       tiny epsilon (rules out perfectly-constant scripted motion);
  //   (b) at least one strict slowdown (deltas[i] < deltas[i-1]) so
  //       monotonically-accelerating bots are also rejected.
  let varied = false;
  let slowedDown = false;
  for (let i = 1; i < deltas.length; i++) {
    if (Math.abs(deltas[i] - deltas[i - 1]) > 1e-3) varied = true;
    if (deltas[i] < deltas[i - 1] - 1e-3) slowedDown = true;
  }
  if (!varied || !slowedDown) {
    return { ok: false, reason: "motion_perfectly_linear" };
  }
  return { ok: true };
}

export async function verifyChallenge(
  params: VerifyParams
): Promise<VerifyResult & { wallet?: string }> {
  const { challengeId, slotX, motionSamples } = params;
  if (!challengeId) return { ok: false, reason: "challenge_not_found" };

  let raw: string | null = null;
  try {
    raw = (await redis.get(challengeKey(challengeId))) as string | null;
  } catch (e: any) {
    console.warn(`[captcha] redis get failed: ${e?.message || e}`);
    return { ok: false, reason: "challenge_not_found" };
  }
  if (!raw) return { ok: false, reason: "challenge_not_found" };

  let stored: StoredChallenge;
  try {
    stored = typeof raw === "string" ? JSON.parse(raw) : (raw as any);
  } catch {
    return { ok: false, reason: "challenge_not_found" };
  }

  // One-shot: drop the challenge so the same id can't be replayed.
  try {
    await redis.del(challengeKey(challengeId));
  } catch {
    /* non-fatal */
  }

  const motion = checkMotionSanity(motionSamples);
  if (!motion.ok) {
    await recordFailure(stored.wallet);
    return { ...motion, wallet: stored.wallet };
  }

  const tol = getCaptchaTolerancePx();
  if (!Number.isFinite(slotX) || Math.abs(Number(slotX) - stored.gapX) > tol) {
    await recordFailure(stored.wallet);
    return { ok: false, reason: "slot_mismatch", wallet: stored.wallet };
  }

  // Pass — flip the verified flag.
  try {
    const setOpts: SetCommandOptions = { ex: DEFAULT_VERIFIED_TTL_SEC };
    await redis.set(verifiedKey(stored.wallet), "1", setOpts);
    await redis.del(failsKey(stored.wallet));
  } catch (e: any) {
    console.warn(`[captcha] redis verified-set failed: ${e?.message || e}`);
    // Fall through — verification still considered successful for this
    // request even if the persistence blip means we'll re-prompt next
    // time. Better than a false failure for a real human.
  }
  return { ok: true, wallet: stored.wallet };
}

async function recordFailure(wallet: string): Promise<void> {
  if (!wallet) return;
  try {
    const fails = await redis.incr(failsKey(wallet));
    if (typeof fails === "number" && fails === 1) {
      // First failure in this window — give the counter a generous TTL
      // so unrelated failures don't compound forever.
      try {
        await redis.expire(failsKey(wallet), 60 * 60);
      } catch {
        /* non-fatal */
      }
    }
    if (typeof fails === "number" && fails >= getCaptchaFailThreshold()) {
      const ttlMs = getCaptchaFailCooldownMs();
      if (ttlMs > 0) {
        const setOpts: SetCommandOptions = { px: ttlMs };
        await redis.set(cooldownKey(wallet), "1", setOpts);
        await redis.del(failsKey(wallet));
      }
    }
  } catch (e: any) {
    console.warn(`[captcha] failure-record failed: ${e?.message || e}`);
  }
}

// --- gate helpers (used by /api/captcha/* and the deposit endpoints) ---

export async function isWalletCaptchaVerified(wallet: string): Promise<boolean> {
  if (!wallet) return false;
  try {
    const v = await redis.get(verifiedKey(wallet));
    return Boolean(v);
  } catch (e: any) {
    console.warn(`[captcha] verified-check failed: ${e?.message || e}`);
    // Fail OPEN — a Redis blip should not block paying users from
    // funding their match. The slider gate is anti-cheat, not auth.
    return true;
  }
}

export async function getCaptchaCooldownRemainingMs(
  wallet: string
): Promise<number> {
  if (!wallet) return 0;
  try {
    const pttl = await redis.pttl(cooldownKey(wallet));
    if (typeof pttl === "number" && pttl > 0) return pttl;
    return 0;
  } catch {
    try {
      const v = await redis.get(cooldownKey(wallet));
      return v ? getCaptchaFailCooldownMs() : 0;
    } catch {
      return 0;
    }
  }
}

// --- deposit gate -------------------------------------------------------

export interface DepositGateOk {
  ok: true;
}
export interface DepositGateBlocked {
  ok: false;
  status: 412 | 429;
  body: {
    error: "captcha_required" | "captcha_cooldown";
    message: string;
    retryAfterMs?: number;
    retryAfterSec?: number;
  };
}
export type DepositGateResult = DepositGateOk | DepositGateBlocked;

export async function checkDepositCaptcha(
  wallet: string
): Promise<DepositGateResult> {
  return checkDepositCaptchaForWallets([wallet]);
}

// Match-bound gate. Pass the depositor wallets read from TRUSTED match
// data (not from the request body) so a scripted client can't bypass
// the gate by submitting some unrelated verified wallet's address. ALL
// supplied wallets must be captcha-verified; if ANY is in failure
// cooldown, the call is refused with 429.
export async function checkDepositCaptchaForWallets(
  wallets: string[]
): Promise<DepositGateResult> {
  const ws = (wallets || []).filter(
    (w): w is string => typeof w === "string" && w.length > 0
  );
  if (ws.length === 0) {
    return {
      ok: false,
      status: 412,
      body: {
        error: "captcha_required",
        message:
          "Please complete the slider verification before depositing.",
      },
    };
  }
  // Cooldown takes precedence so a banned wallet always sees the cooldown
  // message, never a bare "verify yourself" prompt.
  for (const w of ws) {
    const cooldownMs = await getCaptchaCooldownRemainingMs(w);
    if (cooldownMs > 0) {
      return {
        ok: false,
        status: 429,
        body: {
          error: "captcha_cooldown",
          message: "Too many tries — please wait and try again.",
          retryAfterMs: cooldownMs,
          retryAfterSec: Math.max(1, Math.ceil(cooldownMs / 1000)),
        },
      };
    }
  }
  for (const w of ws) {
    const verified = await isWalletCaptchaVerified(w);
    if (!verified) {
      return {
        ok: false,
        status: 412,
        body: {
          error: "captcha_required",
          message:
            "Please complete the slider verification before depositing.",
        },
      };
    }
  }
  return { ok: true };
}

// Test-only — not routed through any module index.
export const __testInternals = {
  challengeKey,
  verifiedKey,
  failsKey,
  cooldownKey,
  checkMotionSanity,
  TRACK_WIDTH,
  TRACK_HEIGHT,
  PIECE_SIZE,
  hashWallet: (w: string) => createHash("sha256").update(w).digest("hex"),
};
