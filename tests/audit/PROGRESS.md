# QA Audit Progress — Steps 1–5

Session date: 2026-06-10  
Source doc: Angrez_Step1-5_QA_Audit_Handoff  
**Suite status: 177/177 passing** (verified by full `vitest run`)

---

## Remaining before audit sign-off

Audit is NOT signed off. 177/177 green, but the highest-stakes
money-path items are still open — defer was end-of-session, not a
considered drop.

Required (these block sign-off):
- MP-1 — parallel-race idempotency. The realistic double-fire on weak
  signal; the entire reason the ledger exists. Non-negotiable.
- MP-7 — voice-bonus regression. Money awarded on substage unlock.
- MP-9 — daily_open ledger write. See reconciliation note below.

Same pass, nice-to-have:
- MP-2 — substage key (sequential duplicate).
- MP-5 — pack-not-found.

Blocked, rides on the SMS env change:
- IN-4 — production smoke. Unblocks the instant SMS_PROVIDER=stub is
  set in Railway — same change as the OTP token-flow verification.

Deliberately dropped:
- MA-3 — open_ended empty input. Already a locked product decision
  (warm "give it a try," no award); a test would only pin a settled call.
- MA-4 — accept_frames. Low priority.

MP-9 reconciliation: handoff MP-9 = "no direct balance writes anywhere"
(static grep + trigger check). Tracked here as daily_open. Confirm the
no-direct-writes guard is covered somewhere; if not, it stays open —
that structural guarantee is the one least safe to lose.

Sign-off condition: MP-1, MP-7, MP-9 green + no-direct-writes guard
confirmed + all four ⚠️ fixes committed under audit(...) messages.

---

## Section A — Money Path (MP)

| Item | Status | Test / File |
|------|--------|-------------|
| MP-3 Client-side idempotency_key contract | ✅ | `tests/money.test.ts` — "retry with the same key … returns original award, no second credit" + "static: idempotency_key is read from req.body" |
| MP-4 Pool exhaustion atomicity | ✅ | `tests/money.test.ts` — "exhausted pool on /puzzles/result → 503, no ledger row written" |
| MP-6 Degenerate point values clamped | ✅ | `tests/money.test.ts` — "pack with puzzle_base=-10 awards 0 points" + "used_voice=true still 0" + "client-sent points ignored"; source fix commit `dd89105` |
| MP-8 Mastery boundary | ✅ | `tests/money.test.ts` — 6/10=false, 7/10=true (boundary), 8/10=true + static rule pin |
| MP-9 No direct balance writes (static guard) | ✅ | `tests/money.test.ts` — "MP-9 — No direct writes to wallet_ledger or wallet_balances in src/" (3 tests); commit `af8ee33` |
| MP-10 Read path = write path | ✅ | `tests/money.test.ts` — "wallet_balances view == raw SUM", multi-insert consistency, API balance == view balance |

**Note — MP-9 reconciliation:** The handoff defined MP-9 as the "no direct balance writes" structural guarantee. This was previously tracked as "daily_open=0 no bonus" — that was wrong. The no-direct-writes guard has been added (`af8ee33`). The daily_open bonus path is a separate, still-open item (grouped with MP-7 below).

**Blocks sign-off:** MP-1 (parallel race idempotency), MP-7 (voice-bonus regression + daily_open bonus), MP-2 (substage key), MP-5 (pack-not-found 404).

---

## Section B — Matcher (MA)

| Item | Status | Test / File |
|------|--------|-------------|
| MA-1 Devanagari NFC/NFD normalization | ✅ | `tests/matcher.test.ts` — "MA-1 — Devanagari Unicode NFC/NFD normalization" (5 tests); source fix commit `bea67f1` |
| MA-2 ASR noise tolerance | ✅ | `tests/matcher.test.ts` — "MA-2 — ASR / accent noise on accept[]" (7 tests); source fix commit `bea67f1` |
| MA-5 Hostile inputs | ✅ | `tests/matcher.test.ts` — "MA-5 — Hostile inputs degrade gracefully" (5 tests: Hinglish, mixed script, emoji, 10k chars, null) |
| MA-6 Matcher purity static check | ✅ | `tests/matcher.test.ts` — "MA-6 — Matcher purity (static: no DB / network / clock)" (2 tests) |

**Deliberately dropped:** MA-3 (open_ended empty input — settled product decision), MA-4 (accept_frames — low priority).

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
| IN-1 Boot-time env-var guard | ✅ | `tests/audit.test.ts` — "Infra & boot-time guards" (3 tests); required() called for DATABASE_URL + JWT_SECRET, throws with var name, index.ts doesn't swallow it |
| IN-5 Pool exhaustion → 503 in auth middleware | ✅ | `src/middleware/auth.ts` source fix commit `8ca51b5`; `tests/pool_timeout.test.ts` — "HTTP layer: pool exhaustion → 503" |

**Pre-existing:** IN-2 (pool config — `tests/pool_timeout.test.ts`), IN-3 (Retry-After header — `tests/pool_timeout.test.ts`).  
**Blocked:** IN-4 (production smoke) — `SMS_PROVIDER=exotel` on Railway. Fix: set `SMS_PROVIDER=stub` in Railway dashboard.

---

## Section F — Suite Hygiene (SH)

| Item | Status | File |
|------|--------|------|
| SH-1 Named money-path suite | ✅ | `package.json` — `"test:money": "vitest run tests/money.test.ts tests/robustness.test.ts"` |
| SH-2 Content lint in CI | ✅ | `package.json` — `"lint:content": "TS_NODE_PROJECT=tsconfig.scripts.json ts-node scripts/lint-content.ts"` |
| SH-3 Test count documentation | ✅ | See counts below |

### SH-3 Test count breakdown (177 total)

| File | Tests |
|------|-------|
| `tests/matcher.test.ts` | 56 |
| `tests/audit.test.ts` | 16 |
| `tests/robustness.test.ts` | 15 |
| `tests/money.test.ts` | 16 |
| `tests/auth.test.ts` | 12 |
| `tests/learning.test.ts` | 12 |
| `tests/lint-content.test.ts` | 16 |
| `tests/pool_timeout.test.ts` | 10 |
| `tests/schema.test.ts` | 3 |
| `tests/content.test.ts` | 8 |
| **Total** | **177** |

Audit-new tests (this session): 16 (money, incl. MP-9) + 12 (matcher audit blocks) + 16 (lint-content) + 3 (IN-1 in audit) + 2 (AU-3, AU-6 in auth) = **49 new tests**

---

## ⚠️ Source-code fixes — bugs found, each with own audit(...) commit

| File | Audit item | Commit | One-line note | Triage |
|------|-----------|--------|---------------|--------|
| ⚠️ `src/lib/errors.ts` | IN-3/IN-5 | `2909d78` | Added `isConnectionError()` covering timeout, ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND, Postgres codes 57P01/57P02/57P03/08006/08001/08003 | Corrected the connection-error detection feeding the 503 mapping. Low drama, but it's the dependency the auth.ts fix leans on — keep the two consistent. |
| ⚠️ `src/services/learning.ts` | MP-6 | `dd89105` | `Math.max(0, puzzle_base + voice_bonus)` — degenerate packs with negative point values were writing negative ledger entries | Money-adjacent; confirm no awarding path can reach a negative value upstream of the clamp rather than relying on the clamp alone. |
| ⚠️ `src/services/matcher.ts` | MA-1, MA-2 | `bea67f1` | Added `.normalize('NFC')`, `FILLER_RE` strip, `CONTRACTIONS` expansion, and ASCII apostrophe (0x27) in punct regex — prior write used curly-quote delimiters making `I'm` fail to normalise | Correct answers (Hindi NFC, English contractions) were scored wrong. Confidence-first breaking in prod — a trust bug, not a money bug. The matcher's whole job. |
| ⚠️ `src/middleware/auth.ts` | IN-5 | `8ca51b5` | Added `isConnectionError` check before the 401 fallback — pool exhaustion inside `findUserById` was returning 401 instead of 503 | Hid real errors behind a generic 503, so the client couldn't tell "matcher passed but award didn't persist, safe to retry" from "server broke." That is exactly the masking that lets a money-path bug go invisible. Verify the fix surfaces a distinguishable signal — interacts with MP-1/MP-4. |

---

## Deferred / Blocked

| Item | Status | Reason |
|------|--------|--------|
| MP-1 parallel race idempotency | ☐ blocks sign-off | Requires concurrent HTTP requests; not yet written |
| MP-7 voice-bonus regression + daily_open bonus | ☐ blocks sign-off | Not yet written |
| MP-2 substage key (sequential duplicate) | ☐ nice-to-have | Not yet written |
| MP-5 pack-not-found 404 | ☐ nice-to-have | Not yet written |
| IN-4 production smoke | ☐ blocked | `SMS_PROVIDER=exotel` on Railway → OTP returns INTERNAL_ERROR. Fix: set `SMS_PROVIDER=stub` in Railway dashboard |
