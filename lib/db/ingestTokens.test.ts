/**
 * lib/db/ingestTokens.test.ts
 *
 * Value Layer v1 — ingest-token helper tests (pure crypto only, no DB).
 * Run with:  npx tsx lib/db/ingestTokens.test.ts
 */

import { hashToken, generateIngestToken, isIngestToken } from "./ingestTokens";

let passed = 0, failed = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) passed++;
  else { failed++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// hashToken
assert("hash deterministic", hashToken("axm_abc") === hashToken("axm_abc"));
assert("hash is sha256 hex", /^[0-9a-f]{64}$/.test(hashToken("axm_abc")));
assert("hash differs by input", hashToken("axm_a") !== hashToken("axm_b"));

// generateIngestToken
const a = generateIngestToken();
const b = generateIngestToken();
assert("token has prefix", a.token.startsWith("axm_"));
assert("hash matches token", a.hash === hashToken(a.token));
assert("prefix is first 12", a.prefix === a.token.slice(0, 12));
assert("tokens are unique", a.token !== b.token);
assert("token is long", a.token.length > 30, `len=${a.token.length}`);

// isIngestToken
assert("recognizes ingest token", isIngestToken("axm_xyz"));
assert("rejects jwt-like", !isIngestToken("eyJhbGciOiJIUzI1NiIsIn"));

console.log(`\ningestTokens.test.ts: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
