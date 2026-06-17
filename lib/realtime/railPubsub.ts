/**
 * lib/realtime/railPubsub.ts
 *
 * Value Layer v1 — RAIL publish seam.
 *
 * Conceptual channel: `rail:{accountId}`. Today this publishes over the existing
 * in-process per-user bus (streamBus → SSE). The interface is deliberately the
 * shape of a Redis pub/sub publisher: to scale horizontally, replace the body of
 * `publishRail` with an ioredis `PUBLISH rail:{accountId} <payload>` and have the
 * SSE route SUBSCRIBE — callers below do not change.
 *
 * Redis is a message bus ONLY (latest-wins compact state); it is never the source
 * of truth. The memory layer (liveState) is.
 */

import { broadcast } from "@/lib/broker/streamBus";
import type { RailState } from "@/lib/rules/types";

/** The compact, contract-validated payload pushed to clients. */
export interface CompactRail {
  equity:            number;
  floor:             number;
  peak:              number;
  bindingBuffer:     number;
  bindingBufferFrac: number;
  bindingRule:       "trailing" | "daily";
  accountSeverity:   number;
  status:            RailState["status"];
  target:            number | null;
  targetProgress:    number | null;
}

export interface RailMessage {
  type:    "rail";
  account: string;
  rail:    CompactRail;
  ts:      number;
}

export function railChannel(accountId: string): string {
  return `rail:${accountId}`;
}

export function compactRail(r: RailState): CompactRail {
  return {
    equity:            r.equity,
    floor:             r.floor,
    peak:              r.peak,
    bindingBuffer:     r.bindingBuffer,
    bindingBufferFrac: r.bindingBufferFrac,
    bindingRule:       r.bindingRule,
    accountSeverity:   r.accountSeverity,
    status:            r.status,
    target:            r.target,
    targetProgress:    r.targetProgress,
  };
}

/**
 * Publish the latest RAIL state for (user, account). In-process today; the
 * payload is keyed by account so a Redis swap maps 1:1 onto `rail:{accountId}`.
 */
export function publishRail(userId: string, accountId: string, rail: RailState): void {
  const msg: RailMessage = {
    type: "rail",
    account: accountId,
    rail: compactRail(rail),
    ts: Date.now(),
  };
  broadcast(userId, msg);
}
