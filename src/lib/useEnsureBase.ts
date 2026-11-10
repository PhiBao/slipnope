"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useAccount, useSwitchChain } from "wagmi";
import { CHAIN_ID, RPC_URL, EXPLORER } from "./contracts";

type Status = "idle" | "switching" | "added" | "failed";

/** Base mainnet params for wallet_addEthereumChain (8453 = 0x2105). */
const BASE_PARAMS = {
  chainId: `0x${CHAIN_ID.toString(16)}`,
  chainName: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [RPC_URL],
  blockExplorerUrls: [EXPLORER],
} as const;

// One switch state for the whole page. The header, the guard card and the
// FairLimit panel all care about the same wallet, so they should not each
// fire their own switch prompt.
type Snapshot = { status: Status; error: string | null };
let snapshot: Snapshot = { status: "idle", error: null };
const listeners = new Set<() => void>();

function publish(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

// Module-level guards so concurrent hook instances prompt only once.
let autoAttemptedFor: number | null = null;
let inFlight = false;

/**
 * Keep the wallet on Base.
 *
 * A guard that only works on one chain should not leave the user on another
 * one. When a wallet connects to the wrong network, this asks it to switch
 * once. If the wallet does not know Base yet (`wallet_addEthereumChain`
 * needed), it adds the chain and switches. If the wallet refuses or cannot
 * switch programmatically, the app exposes a single manual action instead of
 * leaving a dead button.
 */
export function useEnsureBase() {
  const { isConnected, chainId, connector } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { status, error } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const wrongChain = isConnected && chainId !== undefined && chainId !== CHAIN_ID;

  const addBase = useCallback(async () => {
    if (!connector) throw new Error("No wallet connected");
    const provider = (await connector.getProvider()) as {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [BASE_PARAMS],
    });
  }, [connector]);

  const ensure = useCallback(
    async (opts?: { allowAdd?: boolean }) => {
      if (!wrongChain || inFlight) return !wrongChain;
      inFlight = true;
      publish({ status: "switching", error: null });
      try {
        await switchChainAsync({ chainId: CHAIN_ID });
        publish({ status: "idle" });
        return true;
      } catch (e) {
        const err = e as { code?: number; message?: string };
        const unrecognised = err?.code === 4902 || /unrecognized|not added|unknown chain/i.test(err?.message ?? "");
        if (opts?.allowAdd !== false && unrecognised) {
          try {
            await addBase();
            await switchChainAsync({ chainId: CHAIN_ID });
            publish({ status: "added" });
            return true;
          } catch (addErr) {
            publish({
              status: "failed",
              error: addErr instanceof Error ? addErr.message.slice(0, 160) : "Could not add Base",
            });
            return false;
          }
        }
        publish({ status: "failed", error: err?.message?.slice(0, 160) ?? "Switch rejected" });
        return false;
      } finally {
        inFlight = false;
      }
    },
    [wrongChain, switchChainAsync, addBase],
  );

  // Auto-switch when the wallet lands on another chain, once per chain.
  useEffect(() => {
    if (!wrongChain || chainId === undefined) return;
    if (autoAttemptedFor === chainId) return;
    autoAttemptedFor = chainId;
    void ensure();
  }, [wrongChain, chainId, ensure]);

  return { status, error, wrongChain, ensure, addBase, chainId };
}
