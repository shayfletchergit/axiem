/**
 * lib/db/ingestTokens.ts
 *
 * Value Layer v1 — bearer-token auth for the live-P&L producer (browser
 * extension). Tokens are random, hashed-at-rest (SHA-256), shown once, revocable.
 *
 * Hot-path safety: validateIngestToken caches token_hash → userId in memory with
 * a short TTL, so the ingest route (250 ms ticks) hits the DB at most once per
 * token per TTL window, and last_used_at is touched at most once per refresh —
 * never per tick.
 */

import { createHash, randomBytes } from "crypto";
import { createServiceClient } from "@/lib/supabase/server";

const PREFIX = "axm_";
const CACHE_TTL_MS = 30_000;

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateIngestToken(): { token: string; hash: string; prefix: string } {
  const token = PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token), prefix: token.slice(0, 12) };
}

/** True for strings that look like an Axiem ingest token (not a Supabase JWT). */
export function isIngestToken(token: string): boolean {
  return token.startsWith(PREFIX);
}

export interface IngestTokenRow {
  id:           string;
  token_prefix: string;
  label:        string | null;
  created_at:   string;
  last_used_at: string | null;
  revoked_at:   string | null;
}

export async function mintIngestToken(
  userId: string, label: string | null,
): Promise<{ token: string; id: string; prefix: string }> {
  const supabase = createServiceClient();
  const { token, hash, prefix } = generateIngestToken();
  const { data, error } = await supabase
    .from("ingest_tokens")
    .insert({ user_id: userId, token_hash: hash, token_prefix: prefix, label })
    .select("id")
    .single();
  if (error) throw new Error(`[db/ingestTokens] mint failed: ${error.message}`);
  return { token, id: (data as { id: string }).id, prefix }; // plaintext returned ONCE
}

export async function listIngestTokens(userId: string): Promise<IngestTokenRow[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("ingest_tokens")
    .select("id, token_prefix, label, created_at, last_used_at, revoked_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`[db/ingestTokens] list failed: ${error.message}`);
  return (data ?? []) as IngestTokenRow[];
}

export async function revokeIngestToken(userId: string, id: string): Promise<boolean> {
  const supabase = createServiceClient();
  // Fetch the hash first so we can evict the cache immediately on revoke.
  const { data: row } = await supabase
    .from("ingest_tokens").select("token_hash")
    .eq("user_id", userId).eq("id", id).maybeSingle();
  const { error } = await supabase
    .from("ingest_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("user_id", userId).eq("id", id).is("revoked_at", null);
  if (error) throw new Error(`[db/ingestTokens] revoke failed: ${error.message}`);
  if (row?.token_hash) tokenCache.delete((row as { token_hash: string }).token_hash);
  return true;
}

// ── Cached validation (hot path) ──────────────────────────────────────────────

interface CacheEntry { userId: string; exp: number }
const g = globalThis as typeof globalThis & { _axiemTokenCache?: Map<string, CacheEntry> };
if (!g._axiemTokenCache) g._axiemTokenCache = new Map();
const tokenCache = g._axiemTokenCache;

/**
 * Resolve an ingest token to a userId, or null if invalid/revoked. Cached for
 * CACHE_TTL_MS; only on a cache miss is the DB read and last_used_at refreshed.
 */
export async function validateIngestToken(token: string): Promise<string | null> {
  if (!isIngestToken(token)) return null;
  const hash = hashToken(token);
  const now = Date.now();

  const cached = tokenCache.get(hash);
  if (cached && cached.exp > now) return cached.userId;

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("ingest_tokens")
    .select("user_id")
    .eq("token_hash", hash)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !data) { tokenCache.delete(hash); return null; }

  const userId = (data as { user_id: string }).user_id;
  tokenCache.set(hash, { userId, exp: now + CACHE_TTL_MS });
  // Throttled last-used touch (only on refresh ≈ once per TTL, never per tick).
  void supabase.from("ingest_tokens").update({ last_used_at: new Date(now).toISOString() })
    .eq("token_hash", hash);
  return userId;
}
