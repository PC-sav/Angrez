# QA Audit Progress — Steps 1–5

Session date: 2026-06-10  
Source doc: Angrez_Step1-5_QA_Audit_Handoff

---

## Section A — Money Path (MP)

| Item | Status | Test / File |
|------|--------|-------------|
| MP-3 Client-side idempotency_key contract | ✅ Done | `tests/money.test.ts` — "retry with the same key … returns original award, no second credit" + "static: idempotency_key is read from req.body" |
| MP-4 Pool exhaustion atomicity | ✅ Done | `tests/money.test.ts` — "exhausted pool on /puzzles/result → 503, no ledger row written" |
| MP-6 Degenerate point values clamped | ✅ Done | `tests/money.test.ts` — "pack with puzzle_base=-10 awards 0 points" + "used_voice=true still 0"; source fix in `src/services/learning.ts` (`Math.max(0, ...)`) |
| MP-8 Mastery boundary | ✅ Done | `tests/money.test.ts` — 6/10=false, 7/10=true (boundary), 8/10=true + static rule check |
| MP-10 Read path = write path | ✅ Done | `tests/money.test.ts` — "wallet_balances view returns same value as raw SUM", multi-insert consistency, API balance equals view balance |

**Not yet covered this session:** MP-1 (parallel race idempotency), MP-2 (/substage/complete key), MP-5 (pack-not-found 404), MP-7 (voice_bonus gating regression), MP-9 (daily_open=0 no bonus).

---

## Section B — Matcher (MA)

| Item | Status | Test / File |
|------|--------|-------------|
| MA-1 Devanagari NFC/NFD normalization | ✅ Done | `tests/matcher.test.ts` — "MA-1 — Devanagari Unicode NFC/NFD normalization" (5 tests); source fix: `normalise()` calls `.normalize('NFC')` first |
| MA-2 ASR noise tolerance | ✅ Done | `tests/matcher.test.ts` — "MA-2 — ASR / accent noise on accept[]" (7 tests); source fix: `FILLER_RE` strip, `CONTRACTIONS` expansion |
| MA-5 Hostile inputs | ✅ Done | `tests/matcher.test.ts` — "MA-5 — Hostile inputs degrade gracefully" (5 tests: Hinglish, mixed script, emoji, 10k chars, null) |
| MA-6 Matcher purity static check | ✅ Done | `tests/matcher.test.ts` — "MA-6 — Matcher purity (static: no DB / network / clock)" (2 tests) |

**Not yet covered this session:** MA-3 (Hindi-heavy accept phrases), MA-4 (frame boundary enforcement).

---

## Section C — Content Lint (CL)

| Item | Status | Test / File |
|------|--------|-------------|
| CL-1 No unwinnable puzzle | ✅ Done | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |
| CL-2 Mastery attainable | ✅ Done | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |
| CL-3 Audio refs follow audio/ convention | ✅ Done | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |
| CL-4 Devanagari strings NFC | ✅ Done | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |
| CL-5 Schema validation (≥0.2, required fields) | ✅ Done | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |
| CL-6 Sub-stage ID integrity | ✅ Done | `tests/lint-content.test.ts` + `scripts/lint-content.ts` |

All CL items complete.

---

## Section D — Auth (AU)

| Item | Status | Test / File |
|------|--------|-------------|
| AU-3 Rate limit resets after window passes | ✅ Done | `tests/auth.test.ts` — "AU-3 rate limit clears once old OTP codes are outside the window" |
| AU-6 Deleted user → 401 USER_NOT_FOUND, not 500 | ✅ Done | `tests/auth.test.ts` — "AU-6 — GET /api/auth/me for a deleted user" (2 tests) |

**Pre-existing (regression coverage):** AU-1 (`/auth/me` validates JWT), AU-2 (user lookup), AU-4 (expired OTP), AU-5 (missing header) — all covered by existing `tests/auth.test.ts` describe blocks.  
**Not yet covered this session:** Rate-limit counter reset on successful verify (if spec'd separately).

---

## Section E — Infra (IN)

| Item | Status | Test / File |
|------|--------|-------------|
| IN-1 Boot-time env-var guard | ✅ Done | `tests/audit.test.ts` — "Infra & boot-time guards" (3 tests: required() called, required() throws, index.ts doesn't swallow it) |
| IN-5 Pool exhaustion → 503 in auth middleware | ✅ Done | `src/middleware/auth.ts` fix (isConnectionError check); `tests/pool_timeout.test.ts` — "GET /api/auth/me with all pool connections held → 503 SERVICE_UNAVAILABLE" |

**Not yet covered this session:** IN-2 (pool config test — covered in pool_timeout.test.ts "Pool config"), IN-3 (Retry-After header verified — covered in pool_timeout.test.ts), IN-4 (production smoke test, blocked by SMS_PROVIDER=exotel on Railway).

---

## Section F — Suite Hygiene (SH)

| Item | Status | File |
|------|--------|------|
| SH-1 Named money-path suite | ✅ Done | `package.json` — `"test:money": "vitest run tests/money.test.ts tests/robustness.test.ts"` |
| SH-2 Content lint in CI | ✅ Done | `package.json` — `"lint:content": "TS_NODE_PROJECT=tsconfig.scripts.json ts-node scripts/lint-content.ts"` |
| SH-3 Test count documentation | ⏳ Pending | To be written once full suite is green |

---

## Source-code fixes (not just tests)

| Fix | File | Detail |
|-----|------|--------|
| Negative points clamp | `src/services/learning.ts` | `Math.max(0, puzzle_base + voice_bonus)` |
| NFC normalization in matcher | `src/services/matcher.ts` | `normalise()` starts with `.normalize('NFC')`; added filler strip + contraction expansion |
| Pool timeout → 503 in auth middleware | `src/middleware/auth.ts` | `isConnectionError` check before 401 fallback |
| Phone collision in parallel workers | `tests/robustness.test.ts`, `tests/audit.test.ts`, `tests/learning.test.ts`, `tests/pool_timeout.test.ts` | `randomInt(6_000_000_000, 9_999_999_999)` instead of `Date.now()` |

---

## Deferred / Blocked

- **IN-4 production smoke test**: Blocked — Railway has `SMS_PROVIDER=exotel` set; OTP flow returns INTERNAL_ERROR. Fix: set `SMS_PROVIDER=stub` in Railway dashboard.
- **MP-1 parallel race**: Requires concurrent HTTP requests; not yet written.
- **SH-3 test count**: Pending green suite.
