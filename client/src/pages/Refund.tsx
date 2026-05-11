import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { apiUrl } from "@/lib/api";

interface RefundInfo {
  matchId: string;
  escrowAddress: string;
  amountNano: string;
  payloadBoc: string;
  validUntilSec: number;
  stakeNano: string;
  depositorAddress: string;
}

interface RefundError {
  error: string;
  message?: string;
  depositorAddress?: string;
  eligibleAtSec?: number;
  firstDepositAtSec?: number;
  onChainStatus?: number;
}

export default function Refund() {
  const [location] = useLocation();
  const initialMatchId = (() => {
    try {
      const qs = new URLSearchParams(window.location.search);
      return qs.get("matchId") || "";
    } catch {
      return "";
    }
  })();

  const [matchId, setMatchId] = useState(initialMatchId);
  const [tonAddress, setTonAddress] = useState<string | null>(null);
  const [tcReady, setTcReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<RefundInfo | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      const tc = (window as any).__TON_CONNECT_UI__;
      if (cancelled) return;
      if (tc) {
        setTcReady(true);
        const addr = tc.account?.address;
        setTonAddress(addr ? toFriendly(addr) : null);
        try {
          tc.onStatusChange?.((wallet: any) => {
            if (cancelled) return;
            const a = wallet?.account?.address || null;
            setTonAddress(a ? toFriendly(a) : null);
          });
        } catch {}
      } else {
        setTimeout(tick, 200);
      }
    };
    tick();
    return () => { cancelled = true; };
  }, []);

  async function handleConnect() {
    const tc = (window as any).__TON_CONNECT_UI__;
    if (!tc) {
      setErrMsg("TonConnect is still initialising — wait a second and retry.");
      return;
    }
    try {
      tc.openModal();
    } catch (e: any) {
      setErrMsg(`TonConnect open failed: ${e?.message || e}`);
    }
  }

  async function handleDisconnect() {
    const tc = (window as any).__TON_CONNECT_UI__;
    if (!tc) return;
    try {
      await tc.disconnect();
      setTonAddress(null);
      setInfo(null);
      setOkMsg(null);
      setErrMsg(null);
    } catch {}
  }

  async function handleCheckEligibility() {
    setErrMsg(null);
    setOkMsg(null);
    setInfo(null);
    if (!matchId.trim()) {
      setErrMsg("Enter the match ID first.");
      return;
    }
    if (!tonAddress) {
      setErrMsg("Connect your TonConnect wallet first.");
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(apiUrl("/api/ton/refund-info"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId: matchId.trim(), walletAddress: tonAddress }),
      });
      const data = (await r.json().catch(() => ({}))) as RefundInfo & RefundError;
      if (!r.ok) {
        setErrMsg(formatRefundError(data));
        return;
      }
      setInfo(data);
    } catch (e: any) {
      setErrMsg(`Network error: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleSendRefund() {
    if (!info) return;
    setErrMsg(null);
    setOkMsg(null);
    const tc = (window as any).__TON_CONNECT_UI__;
    if (!tc || !tc.connected) {
      setErrMsg("TonConnect disconnected — reconnect and try again.");
      return;
    }
    setBusy(true);
    try {
      await tc.sendTransaction({
        validUntil: info.validUntilSec,
        messages: [
          {
            address: info.escrowAddress,
            amount: info.amountNano,
            payload: info.payloadBoc,
          },
        ],
      });
      const stakeTon = (Number(info.stakeNano) / 1e9).toFixed(4);
      setOkMsg(
        `Refund transaction signed and broadcast. ${stakeTon} TON should land back in ${info.depositorAddress} within ~30 seconds. You can close this page after you see the credit in TonKeeper.`
      );
      setInfo(null);
    } catch (e: any) {
      setErrMsg(
        `Refund send failed: ${e?.message || e}. If TonKeeper still showed the prompt and you confirmed it, the TX may have landed anyway — check your wallet history before retrying.`
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl p-6 space-y-6 text-white">
      <div>
        <h1 className="text-2xl font-bold">TON Refund</h1>
        <p className="mt-2 text-sm text-zinc-400">
          Recover a TON deposit from a match that never started (your opponent
          never deposited and the on-chain timeout has elapsed). Only the
          original depositor wallet can claim. Costs ~0.05 TON gas; the contract
          refunds your full stake.
        </p>
      </div>

      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <div className="text-xs font-semibold uppercase text-zinc-500">Wallet</div>
        {tonAddress ? (
          <div className="flex items-center justify-between gap-4">
            <code className="break-all text-xs text-emerald-400">{tonAddress}</code>
            <button
              type="button"
              onClick={handleDisconnect}
              className="rounded border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleConnect}
            disabled={!tcReady}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-semibold hover:bg-blue-500 disabled:opacity-50"
          >
            {tcReady ? "Connect TonConnect wallet" : "Loading TonConnect…"}
          </button>
        )}
      </div>

      <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <label className="text-xs font-semibold uppercase text-zinc-500">Match ID</label>
        <input
          type="text"
          value={matchId}
          onChange={(e) => { setMatchId(e.target.value); setInfo(null); setErrMsg(null); setOkMsg(null); }}
          placeholder="e.g. 5wM7VYhT99LAR4FLb_ejR"
          className="w-full rounded border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm focus:border-blue-500 focus:outline-none"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={handleCheckEligibility}
          disabled={busy || !tonAddress}
          className="w-full rounded bg-zinc-800 px-4 py-2 text-sm font-semibold hover:bg-zinc-700 disabled:opacity-50"
        >
          {busy ? "Checking…" : "Check refund eligibility"}
        </button>
      </div>

      {info && (
        <div className="space-y-3 rounded-lg border border-emerald-700 bg-emerald-950/30 p-4">
          <div className="text-sm font-semibold text-emerald-400">Eligible for refund</div>
          <div className="text-xs text-zinc-400">
            Stake: <span className="font-mono text-white">{(Number(info.stakeNano) / 1e9).toFixed(4)} TON</span>
            {" "}refunded to <span className="font-mono text-white break-all">{info.depositorAddress}</span>.
            Gas cost: ~0.05 TON.
          </div>
          <button
            type="button"
            onClick={handleSendRefund}
            disabled={busy}
            className="w-full rounded bg-emerald-600 px-4 py-2 text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? "Sending…" : "Send refund transaction"}
          </button>
        </div>
      )}

      {okMsg && (
        <div className="rounded-lg border border-emerald-700 bg-emerald-950/30 p-4 text-sm text-emerald-200">
          {okMsg}
        </div>
      )}

      {errMsg && (
        <div className="rounded-lg border border-red-700 bg-red-950/30 p-4 text-sm text-red-200">
          {errMsg}
        </div>
      )}
    </div>
  );
}

function toFriendly(rawOrFriendly: string): string {
  try {
    if (rawOrFriendly.includes(":")) {
      const [wc, hex] = rawOrFriendly.split(":");
      const buf = new Uint8Array(32);
      for (let i = 0; i < 32; i++) buf[i] = parseInt(hex.substr(i * 2, 2), 16);
      void wc; void buf;
    }
  } catch {}
  return rawOrFriendly;
}

function formatRefundError(data: RefundError): string {
  const code = data?.error || "unknown";
  const base = data?.message || "Refund check failed.";
  if (code === "not_depositor" && data.depositorAddress) {
    return `${base}`;
  }
  if (code === "timeout_not_elapsed" && data.eligibleAtSec) {
    const secs = Math.max(0, data.eligibleAtSec - Math.floor(Date.now() / 1000));
    const mins = Math.ceil(secs / 60);
    return `${base} Try again in ~${mins} minute${mins === 1 ? "" : "s"}.`;
  }
  if (code === "match_not_found") {
    return `${base} Double-check the match ID.`;
  }
  return base;
}
