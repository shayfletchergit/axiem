const lsKey = (id: string) => `axiem:cursor:${id}`;

// ── localStorage (fast, sync) ─────────────────────────────────────────────

function lsLoad(accountId: string): string | null {
  try { return localStorage.getItem(lsKey(accountId)); } catch { return null; }
}

function lsSave(accountId: string, cursor: string): void {
  try { localStorage.setItem(lsKey(accountId), cursor); } catch {}
}

function lsClear(accountId: string): void {
  try { localStorage.removeItem(lsKey(accountId)); } catch {}
}

// ── Server backing store (durable, async) ────────────────────────────────
// In-memory in the Next.js API route for MVP.
// Replace with Supabase upsert when multi-device sync is needed.

async function serverLoad(accountId: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/cursor?accountId=${encodeURIComponent(accountId)}`);
    if (!res.ok) return null;
    const { cursor } = await res.json();
    return cursor ?? null;
  } catch { return null; }
}

function serverSave(accountId: string, cursor: string): void {
  // Fire-and-forget — don't block the caller on a network write
  fetch("/api/cursor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId, cursor }),
  }).catch(() => {});
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Load cursor: localStorage first (instant), then server (survives clears).
 * On session start, call this once and use the returned value.
 */
export async function loadCursor(accountId: string): Promise<string | null> {
  const local = lsLoad(accountId);
  if (local) return local;

  const remote = await serverLoad(accountId);
  if (remote) {
    lsSave(accountId, remote);  // repopulate localStorage
    return remote;
  }
  return null;
}

/**
 * Persist cursor after each successful batch of fills.
 * localStorage is synchronous (no latency), server write is fire-and-forget.
 */
export function saveCursor(accountId: string, cursor: string): void {
  lsSave(accountId, cursor);
  serverSave(accountId, cursor);
}

export function clearCursor(accountId: string): void {
  lsClear(accountId);
  serverSave(accountId, "");  // overwrite server cursor with empty string
}
