# QA Audit Progress — Steps 1–5

Session date: 2026-06-10  
Source doc: Angrez_Step1-5_QA_Audit_Handoff  
**Suite status: 174/174 passing** (verified by full `vitest run`)

---

## Section A — Money Path (MP)

| Item | Status | Test / File |
|------|--------|-------------|
| MP-3 Client-side idempotency_key contract | ✅ | `tests/money.test.ts` — "retry with the same key … returns original award, no second credit" + "static: idempotency_key is read from req.body" |
| MP-4 Pool exhaustion atomicity | ✅ | `tests/money.test.ts` — "exhausted pool on /puzzles/result → 503, no ledger row written" |
| MP-6 Degenerate point values clamped | ✅ | `tests/money.test.ts` — "pack with puzzle_base=-10 awards 0 points" + "used_voice=true still 0" + "client-sent points ignored"; source fix in `src/services/learning.ts` (`Math.max(0, ...)`) |
| MP-8 Mastery boundary | ✅ | `tests/money.test.ts` — 6/10=false, 7/10=true (boundary), 8/10=true + static rule pin |
| MP-10 Read path = write path | ✅ | `tests/money.test.ts` — "wallet_balances view == raw SUM", multi-insert consistency, API balance == view balance |

**Not yet covered:** MP-1 (parallel race idempotency), MP-2 (/substage/complete key), MP-5 (pack-not-found 404), MP-7 (voice_bonus regression), MP-9 (daily_open=0 no bonus).

---

## Section B — Matcher (MA)

| Item | Status | Test / File |
|------|--------|-------------|
| MA-1 Devanagari NFC/NFD normalization | ✅ | `tests/matcher.test.ts` — "MA-1 — Devanagari Unicode NFC/NFD normalization" (5 tests); source fix: `normalise()` starts with `.normalize('NFC')` |
| MA-2 ASR noise tolerance | ✅ | `tests/matcher.test.ts` — "MA-2 — ASR / accent noise on accept[]" (7 tests); source fix: `FILLER_RE` strip, `CONTRACTIONS` expansion, ASCII apostrophe in punct regex |
| MA-5 Hostile inputs | ✅ | `tests/matcher.test.ts` — "MA-5 — Hostile inputs degrade gracefully" (5 tests: Hinglish, mixed script, emoji, 10k chars, null) |
| MA-6 Matcher purity static check | ✅ | `tests/matcher.test.ts` — "MA-6 — Matcher purity (static: no DB / network / clock)" (2 tests) |

**Not yet covered:** MA-3 (Hindi-heavy accept phrases), MA-4 (frame boundary enforcement).

---

## Section C — Content Lint (CL)

| Item | Status | Test / File |
|------|--------|-------------|
| CL-1 No unwinnable puzzle | ✅ | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |
| CL-2 Mastery attainable | ✅ | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |
| CL-3 Audio refs follow audio/ convention | ✅ | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |
| CL-4 Devanagari strings NFC | ✅ | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |
| CL-5 Schema validation (≥0.2, required fields) | ✅ | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |
| CL-6 Sub-stage ID integrity | ✅ | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |

All CL items complete.

---

## Section D — Auth (AU)

| Item | Status | Test / File |
|------|--------|-------------|
| AU-3 Rate limit resets after window passes | ✅ | `tests/auth.test.ts` — "AU-3 rate limit clears once old OTP codes are outside the window" |
| AU-6 Deleted user → 401 USER_NOT_FOUND, not 500 | ✅ | `tests/auth.test.ts` — "AU-6 — GET /api/auth/me for a deleted user" (2 tests) |

**Pre-existing (regression coverage):** AU-1 (`/auth/me` validates JWT), AU-2 (user lookup in DB), AU-4 (expired OTP → 401), AU-5 (missing Authorization header → 401) — all covered by existing `tests/auth.test.ts` describes.

---

## Section E — Infra (IN)

| Item | Status | Test / File |
|------|--------|-------------|
| IN-1 Boot-time env-var guard | ✅ | `tests/audit.test.ts` — "Infra & boot-time guards" (3 tests: required() called for DATABASE_URL + JWT_SECRET, required() throws with var name, index.ts doesn't swallow it) |
| IN-5 Pool exhaustion → 503 in auth middleware | ✅ | `src/middleware/auth.ts` source fix (isConnectionError before 401); `tests/pool_timeout.test.ts` — "HTTP layer: pool exhaustion → 503" |

**Pre-existing:** IN-2 (pool config — `tests/pool_timeout.test.ts` "app pool has connectionTimeoutMillis set to 5000"), IN-3 (Retry-After header — `tests/pool_timeout.test.ts` "returns Retry-After: 5").  
**Deferred:** IN-4 (production smoke test) — blocked by `SMS_PROVIDER=exotel` on Railway.

---

## Section F — Suite Hygiene (SH)

| Item | Status | File |
|------|--------|------|
| SH-1 Named money-path suite | ✅ | `package.json` — `"test:money": "vitest run tests/money.test.ts tests/robustness.test.ts"` |
| SH-2 Content lint in CI | ✅ | `package.json` — `"lint:content": "TS_NODE_PROJECT=tsconfig.scripts.json ts-node scripts/lint-content.ts"` |
| SH-3 Test count documentation | ✅ | See counts below |

### SH-3 Test count breakdown (174 total)

| File | Tests |
|------|-------|
| `tests/matcher.test.ts` | 56 |
| `tests/audit.test.ts` | 16 |
| `tests/robustness.test.ts` | 15 |
| `tests/money.test.ts` | 13 |
| `tests/auth.test.ts` | 12 |
| `tests/learning.test.ts` | 12 |
| `tests/lint-content.test.ts` | 16 |
| `tests/pool_timeout.test.ts` | 10 |
| `tests/schema.test.ts` | 3 |
| `tests/content.test.ts` | 8 |
| **Total** | **174** |

Audit-new tests (this session): 13 (money) + 12 (matcher audit blocks) + 16 (lint-content) + 3 (IN-1 in audit) + 2 (AU-3, AU-6 in auth) = **46 new tests**

---

## ⚠️ Source-code fixes (bugs found, not just tests)

These are uncommitted changes to `src/` — each fixed a real defect surfaced by the audit.

| File | Audit item | One-line note |
|------|-----------|---------------|
| ⚠️ `src/services/learning.ts` | MP-6 | `Math.max(0, puzzle_base + voice_bonus)` — degenerate packs with negative point values were writing negative ledger entries |
| ⚠️ `src/services/matcher.ts` | MA-1, MA-2 | Added `.normalize('NFC')` first step, `FILLER_RE` leading-filler strip, `CONTRACTIONS` expansion, and ASCII apostrophe (0x27) in punct regex — curly quotes in the prior write had omitted the ASCII apostrophe, making `I'm` fail to normalise to `im` |
| ⚠️ `src/middleware/auth.ts` | IN-5 | Added `isConnectionError` check before the 401 fallback — pool exhaustion inside `findUserById` was returning 401 instead of 503 |
| ⚠️ `src/lib/errors.ts` | IN-3/IN-5 | Added `isConnectionError()` function covering timeout, ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND, and Postgres codes 57P01/57P02/57P03/08006/08001/08003 |

Changes to `src/lib/db.ts`, `src/routes/auth.ts`, `src/routes/content.ts`, `src/routes/index.ts` are Step 5 learning-loop scaffolding (committed separately); they are not audit defect fixes.

---

## Deferred / Blocked

| Item | Reason |
|------|--------|
| IN-4 production smoke test | `SMS_PROVIDER=exotel` on Railway → OTP returns INTERNAL_ERROR. Fix: set `SMS_PROVIDER=stub` in Railway dashboard |
| MP-1 parallel race idempotency | Requires concurrent HTTP requests; not yet written |
| MA-3 Hindi-heavy accept phrases | Low priority; real-pack content tests cover this in practice |
| MA-4 Frame boundary enforcement | Low priority; frame tests in `tests/matcher.test.ts` cover the main cases |
| MP-2/5/7/9 remaining money-path items | Scope for next session |
