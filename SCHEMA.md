# Angrez — Database Schema

Postgres on Supabase. All tables use `UUID PRIMARY KEY DEFAULT gen_random_uuid()` and `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`.

---

## Running Migrations

```bash
# Apply all pending migrations
npm run migrate

# Roll back the most recently applied migration
npm run migrate:undo

# See which migrations have been applied and when
npm run migrate:status
```

Migration files live in `migrations/`. Each up-migration is `NNN_description.sql`; its rollback is `NNN_description.undo.sql`. Applied migrations are tracked in the `schema_migrations` table (auto-created on first run). Every migration runs inside a transaction — a failure triggers `ROLLBACK`.

---

## Tables

### `users`
Core identity. `phone` is the primary login identifier (unique). `google_id` is populated on Google Sign-In (nullable, unique). `language` defaults to `'hi'` (Hindi); the field is present now so multi-language expansion requires no schema change.

### `otp_codes`
One row per OTP send. `code_hash` stores a hash (bcrypt or SHA-256 + salt) of the 6-digit code — the raw code is never persisted. `consumed_at` is set when the OTP is successfully verified. `attempts` counts failed verify attempts; the application enforces the cap. Index on `phone`.

### `content_packs`
Versioned content blobs. `json` (JSONB) holds sub-stages, puzzles, and audio refs. Unique constraint on `(stage, version, language)` prevents accidental duplicate publish. `published_at` is null for drafts.

### `progress`
One row per `(user_id, sub_stage_id)` pair — enforced by a `UNIQUE (user_id, sub_stage_id)` constraint (added in migration 003) which enables safe `ON CONFLICT` upserts. `mastery_score` is a 0–100 percentage. `status` is one of `not_started | in_progress | complete`. `updated_at` is bumped automatically by a database trigger on every UPDATE. Foreign key cascades on user delete.

### `puzzle_results`
Immutable result log — one row per attempt. `sub_stage_id TEXT NOT NULL` (added in migration 003) links each result to its sub-stage so mastery can be computed. `idempotency_key` on `wallet_ledger` (not here) ensures points are not double-credited even if this row is resubmitted. Index on `user_id`.

### `wallet_ledger` ⚠️ APPEND-ONLY
See the section below. Index on `user_id` (via the FK).

### `wallet_balances` (view)
```sql
SELECT user_id, COALESCE(SUM(delta_points), 0)::INT AS balance
FROM wallet_ledger
GROUP BY user_id;
```
Always read a user's balance from this view or the equivalent query. **Never store a balance column anywhere.**

### `subscriptions`
One active subscription per user (enforced by the application, not a DB constraint). `plan` is one of `free | trial | monthly | annual`. `payu_ref` is the PayU transaction reference (populated in a later sprint).

### `referrals`
`referrer_id` is required; `referred_id` is null until the referred user signs up. `bonus_state` tracks the reward FSM: `pending → signup_rewarded → converted | void`. The conversion bonus logic is stubbed in Step 7.

### `analytics_events`
Append-only event log. `user_id` is nullable (pre-auth events). `props` is freeform JSONB. Index on `event_name` for aggregation queries. **No UPDATE or DELETE triggers** — this table is not as strict as `wallet_ledger`, but the application should never mutate rows.

---

## The Wallet Ledger Rules

The wallet is a **financial ledger**, not a counter. These rules are non-negotiable:

| Rule | Where enforced |
|------|----------------|
| No UPDATE on any ledger row | DB trigger (`wallet_ledger_no_update`) |
| No DELETE on any ledger row | DB trigger (`wallet_ledger_no_delete`) |
| No double-credit | UNIQUE constraint on `idempotency_key` |
| No stored balance | Architectural rule — no `balance` column exists |
| Every change logged | `reason TEXT NOT NULL` on every row |
| User deletion blocked if ledger exists | FK `ON DELETE RESTRICT` |

**Reading balance:**
```sql
-- For one user:
SELECT COALESCE(SUM(delta_points), 0) AS balance
FROM wallet_ledger WHERE user_id = $1;

-- For all users (via view):
SELECT * FROM wallet_balances WHERE user_id = $1;
```

**Writing a ledger entry (the only allowed operation):**
```sql
INSERT INTO wallet_ledger (user_id, delta_points, reason, idempotency_key, ref_id)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (idempotency_key) DO NOTHING;
```
The `ON CONFLICT DO NOTHING` makes every award idempotent — retrying the same `idempotency_key` is a no-op.

---

## Schema Migrations Table

```
schema_migrations
  filename    TEXT (PK)   — e.g. "001_init.sql"
  applied_at  TIMESTAMPTZ — when this migration was applied
```

Created automatically on first `npm run migrate` run. Managed by `scripts/migrate.ts`.
