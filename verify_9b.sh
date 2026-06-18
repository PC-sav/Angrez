#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Step 9B Production Verification — HTTP-only
# Working dir: /Users/Pratap1/angrez  |  railway authenticated  |  jq required
# Admin API is at /admin/... (no /api prefix — see app.ts:15-16)
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "jq required: brew install jq"; exit 1; }

BASE="https://angrez-production.up.railway.app"
FC7_PHONE="+916000000001"
OTP_CODE="999999"

# ─────────────────────────────────────────────────────────────────────────────
# Bootstrap: acquire admin key from Railway env (length echoed, value never)
# ─────────────────────────────────────────────────────────────────────────────
echo "▶ Acquiring admin key..."
ADMIN_KEY=$(railway run npx ts-node --transpile-only -e "process.stdout.write(process.env.ADMIN_API_KEY||'')" 2>/dev/null)
[ -z "$ADMIN_KEY" ] && { echo "ERROR: ADMIN_API_KEY not set in Railway env"; exit 1; }
echo "  ${#ADMIN_KEY} chars"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

# Seed a bcrypt OTP row for a phone without creating the user.
# Call as: seed_otp "+91XXXXXXXXXX"
seed_otp() {
  export SEED_PHONE="$1"
  railway run npx ts-node --transpile-only << 'JS' 2>/dev/null
const bcrypt = require('bcrypt');
const pool   = require('./src/lib/db').default;
(async () => {
  const phone = process.env.SEED_PHONE;
  await pool.query('DELETE FROM otp_codes WHERE phone=$1', [phone]);
  await pool.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
    [phone, await bcrypt.hash('999999', 10)]
  );
  await pool.end();
})().catch(e => { process.stderr.write(String(e)+'\n'); process.exit(1); });
JS
}

# POST /api/auth/otp/verify and return the full JSON response body.
verify_otp() {
  local phone="$1"
  curl -s -X POST "$BASE/api/auth/otp/verify" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg p "$phone" --arg c "$OTP_CODE" '{phone:$p,code:$c}')"
}

# POST all sub-stage 1.1 puzzles via real HTTP for a given JWT token.
# Reads global PUZZLES_JSON set in PRE-FLIGHT A.
submit_puzzles() {
  local token="$1"
  local count i puzzle_id transcript idem body http_code

  count=$(echo "$PUZZLES_JSON" | jq 'length')
  for i in $(seq 0 $((count - 1))); do
    puzzle_id=$(echo "$PUZZLES_JSON" | jq -r ".[$i].id")
    transcript=$(echo "$PUZZLES_JSON" | jq -r ".[$i].transcript")
    idem=$(node -e "const {randomUUID}=require('crypto');console.log(randomUUID())")

    body=$(jq -n \
      --arg ss  "1.1" \
      --arg pid "$puzzle_id" \
      --arg tr  "$transcript" \
      --arg ik  "$idem" \
      '{sub_stage_id:$ss,puzzle_id:$pid,transcript:$tr,used_voice:false,idempotency_key:$ik}')

    http_code=$(curl -s -o /tmp/9b_puz -w "%{http_code}" \
      -X POST "$BASE/api/puzzles/result" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $token" \
      -d "$body")

    [ "$http_code" != "200" ] && {
      echo "  FAIL $http_code on $puzzle_id: $(cat /tmp/9b_puz)"; exit 1
    }
    echo "  [$((i+1))/$count] $puzzle_id  pass=$(jq -r .pass /tmp/9b_puz)  pts=$(jq -r .points_awarded /tmp/9b_puz)"
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# PRE-FLIGHT A: sub-stage 1.1 puzzle data (read-only railway run)
# Stores puzzle id+transcript pairs in PUZZLES_JSON for use by submit_puzzles().
# Human-readable output goes to stderr (visible on terminal).
# ─────────────────────────────────────────────────────────────────────────────
echo ""; echo "▶ PRE-FLIGHT A: sub-stage 1.1 puzzle data"
PUZZLES_JSON=$(railway run npx ts-node --transpile-only << 'JS'
const pool = require('./src/lib/db').default;
(async () => {
  const { rows } = await pool.query(`
    SELECT
      p->>'id'                                          AS id,
      p->'accept'                                       AS accepts,
      p->>'open_ended'                                  AS open_ended,
      (json->'points'->>'puzzle_base')::int             AS pb,
      (json->'points'->>'sub_stage_complete')::int      AS ssc,
      (json->'points'->>'sub_stage_perfect_bonus')::int AS pfb
    FROM content_packs cp,
         jsonb_array_elements(json->'sub_stages') ss,
         jsonb_array_elements(
           COALESCE((ss->'practice')::jsonb,'[]') ||
           COALESCE((ss->'mastery_check')::jsonb,'[]')
         ) p
    WHERE cp.language='hi' AND ss->>'id'='1.1' AND published_at IS NOT NULL
    ORDER BY (json->>'version')::int DESC
  `);
  rows.forEach((r,i) => process.stderr.write(
    `[${i+1}] ${r.id}  open_ended=${r.open_ended??'false'}  accepts:${JSON.stringify(r.accepts)}\n`
  ));
  const x = rows[0];
  process.stderr.write(`\nCount:${rows.length}  puzzle_base:${x.pb}  ss_complete:${x.ssc}  perfect_bonus:${x.pfb}\n`);
  process.stderr.write(`Expected completeSubStage points_awarded (all correct, first-time, perfect): ${x.ssc+x.pfb}\n`);
  console.log(JSON.stringify(rows.map(r => ({ id: r.id, transcript: r.accepts?.[0] ?? 'हाँ' }))));
  await pool.end();
})().catch(e => { process.stderr.write(String(e)+'\n'); process.exit(1); });
JS
)
echo "Puzzles loaded: $(echo "$PUZZLES_JSON" | jq 'length')"

# ─────────────────────────────────────────────────────────────────────────────
# PRE-FLIGHT B: fc7dac6d baseline state (read-only railway run)
# ─────────────────────────────────────────────────────────────────────────────
echo ""; echo "▶ PRE-FLIGHT B: fc7dac6d baseline"
railway run npx ts-node --transpile-only << 'JS'
const pool = require('./src/lib/db').default;
(async () => {
  const { rows: [u] } = await pool.query(
    'SELECT id FROM users WHERE phone=$1', ['+916000000001']
  );
  if (!u) { console.log('ERROR: fc7dac6d not found'); process.exit(1); }
  const id = u.id;
  console.log('id:', id);
  const [wl, pr, prog, dn] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM wallet_ledger WHERE user_id=$1',[id]),
    pool.query('SELECT COUNT(*)::int AS c FROM puzzle_results WHERE user_id=$1 AND sub_stage_id=$2',[id,'1.1']),
    pool.query('SELECT status, mastery_score FROM progress WHERE user_id=$1 AND sub_stage_id=$2',[id,'1.1']),
    pool.query('SELECT COUNT(*)::int AS c FROM daily_first_n WHERE user_id=$1',[id]),
  ]);
  console.log('wallet_ledger:', wl.rows[0].c, ' (expect ≥1)');
  console.log('puzzle_results 1.1:', pr.rows[0].c, ' (expect 0)');
  console.log('progress 1.1:', JSON.stringify(prog.rows[0] ?? null));
  console.log('daily_first_n (any campaign):', dn.rows[0].c, ' (expect 0 for today)');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
JS

echo ""; echo "Confirm pre-flight output. Press Enter to proceed or Ctrl+C to abort."; read -r

# ═════════════════════════════════════════════════════════════════════════════
# PART 1 — FIRST-N SIGNUP TEST
# ═════════════════════════════════════════════════════════════════════════════

# ── Step 1: Create prod-9b-firstn via POST /admin/campaigns ──────────────────
# -- PRE-FLIGHT C: read current first-N high-water mark, size quota to it --
echo ""; echo "PRE-FLIGHT C: current first-N high-water mark"
FIRSTN_RAW=$(railway run npx ts-node --transpile-only <<'JS' 2>/dev/null
const pool=require('./src/lib/db').default;
(async()=>{
  const {rows:[r]}=await pool.query("SELECT COALESCE(MAX(signup_rank::bigint),0) AS m FROM first_n_signups");
  console.log('RANKBASE='+String(r.m));
  await pool.end();
})().catch(e=>{process.stderr.write(String(e)+'\n');process.exit(1);});
JS
)
FIRSTN_BASE=$(echo "$FIRSTN_RAW" | grep -o 'RANKBASE=[0-9]*' | head -1 | cut -d= -f2)
case "$FIRSTN_BASE" in ''|*[!0-9]*) echo "ERROR: bad signup_rank read: [$FIRSTN_RAW]"; exit 1;; esac
export FIRSTN_BASE
export QUOTA=$((FIRSTN_BASE + 2))
echo "  current max signup_rank: $FIRSTN_BASE  ->  test quota: $QUOTA (3 users land base+1,+2,+3; +1/+2 grant, +3 does not)"

echo ""; echo "▶ STEP 1: Create prod-9b-firstn campaign"
STARTS=$(node -e "console.log(new Date().toISOString())")
ENDS=$(node   -e "console.log(new Date(Date.now()+3*3600000).toISOString())")

HTTP=$(curl -s -o /tmp/9b_c1 -w "%{http_code}" \
  -X POST "$BASE/admin/campaigns" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: $ADMIN_KEY" \
  -d "$(jq -n \
        --arg id  "prod-9b-firstn" \
        --arg nm  "Prod 9B First-N" \
        --arg s   "$STARTS" \
        --arg e   "$ENDS" \
        --argjson q "$QUOTA" \
        '{id:$id,name:$nm,type:"first_n",starts_at:$s,ends_at:$e,award_points:0,quota:$q,active:true}')")
[ "$HTTP" != "201" ] && {
  echo "FAIL $HTTP: $(cat /tmp/9b_c1)"
  echo "(If campaign exists from a prior run, DELETE it via direct SQL first)"
  exit 1
}
echo "  OK  id=$(jq -r .id /tmp/9b_c1)  quota=$(jq .quota /tmp/9b_c1)  award_points=$(jq .award_points /tmp/9b_c1)"
# createCampaign never sets active in the INSERT (DB default=false) — activate explicitly via PATCH
HTTP=$(curl -s -o /tmp/9b_act1 -w "%{http_code}" \
  -X PATCH "$BASE/admin/campaigns/prod-9b-firstn" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: $ADMIN_KEY" \
  -d '{"active":true}')
[ "$HTTP" != "200" ] && { echo "FAIL activation $HTTP: $(cat /tmp/9b_act1)"; exit 1; }
echo "  activated: active=$(jq '.active' /tmp/9b_act1) (expect true)"

# ── Step 2: Seed OTPs for 3 new phones, then POST /api/auth/otp/verify ────────
echo ""; echo "▶ STEP 2: Sign up 3 test users via OTP bypass → POST /api/auth/otp/verify"

PHONES_JSON=$(railway run npx ts-node --transpile-only << 'JS' 2>/dev/null
const bcrypt = require('bcrypt');
const pool   = require('./src/lib/db').default;
const { randomInt } = require('crypto');
(async () => {
  const hash   = await bcrypt.hash('999999', 10);
  const phones = Array.from({ length: 3 }, () => '+91' + randomInt(6_000_000_000, 9_999_999_999));
  for (const phone of phones) {
    await pool.query('DELETE FROM otp_codes WHERE phone=$1', [phone]);
    await pool.query(
      `INSERT INTO otp_codes (phone, code_hash, expires_at)
       VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
      [phone, hash]
    );
  }
  console.log(JSON.stringify(phones));
  await pool.end();
})().catch(e => { process.stderr.write(String(e)+'\n'); process.exit(1); });
JS
)

USER1_PHONE=$(echo "$PHONES_JSON" | jq -r '.[0]')
USER2_PHONE=$(echo "$PHONES_JSON" | jq -r '.[1]')
USER3_PHONE=$(echo "$PHONES_JSON" | jq -r '.[2]')

U1=$(verify_otp "$USER1_PHONE"); USER1_ID=$(echo "$U1" | jq -r '.user.id')
U2=$(verify_otp "$USER2_PHONE"); USER2_ID=$(echo "$U2" | jq -r '.user.id')
U3=$(verify_otp "$USER3_PHONE"); USER3_ID=$(echo "$U3" | jq -r '.user.id')

echo "  USER1: ${USER1_ID}  isNewUser=$(echo "$U1"|jq -r .isNewUser)"
echo "  USER2: ${USER2_ID}  isNewUser=$(echo "$U2"|jq -r .isNewUser)"
echo "  USER3: ${USER3_ID}  isNewUser=$(echo "$U3"|jq -r .isNewUser)"
echo "  (expect isNewUser=true for all 3 — runFirstNSignupHook fires inside the route)"

export FIRSTN_IDS="$USER1_ID,$USER2_ID,$USER3_ID"
export FIRSTN_PHONES="$USER1_PHONE,$USER2_PHONE,$USER3_PHONE"

# ── Step 3: Verify first-N DB state ───────────────────────────────────────────
echo ""; echo "▶ STEP 3: Verify first-N DB state"
railway run npx ts-node --transpile-only << 'JS'
const pool = require('./src/lib/db').default;
(async () => {
  const users = process.env.FIRSTN_IDS.split(',');
  const base  = parseInt(process.env.FIRSTN_BASE,10);
  const quota = parseInt(process.env.QUOTA,10);

  const { rows: ranks } = await pool.query(
    `SELECT user_id, signup_rank::bigint AS r FROM first_n_signups
     WHERE user_id = ANY($1::uuid[]) ORDER BY signup_rank::bigint`, [users]);
  console.log(`\nfirst_n_signups (${ranks.length}/3):`);
  ranks.forEach(r => console.log(`  rank ${r.r}: ${r.user_id.slice(0,8)}`));

  const got = ranks.map(r => Number(r.r));
  const expected = [base+1, base+2, base+3];
  const consecutive = JSON.stringify(got) === JSON.stringify(expected);
  console.log(`  ranks consecutive from base (${expected.join(',')}): ${consecutive ? 'YES' : 'NO -- concurrent signup skewed test, inconclusive'}`);

  const expectedGrants = got.filter(r => r <= quota).length;

  const { rows: grants } = await pool.query(
    `SELECT user_id FROM campaign_grants WHERE campaign_id='prod-9b-firstn' ORDER BY granted_at`);
  console.log(`\ncampaign_grants (${grants.length}, expect ${expectedGrants}):`);
  grants.forEach((g,i) => console.log(`  [${i+1}] ${g.user_id.slice(0,8)}`));

  const { rows: [camp] } = await pool.query(
    `SELECT granted_count FROM campaigns WHERE id='prod-9b-firstn'`);
  console.log(`\ngranted_count: ${camp.granted_count} (expect ${expectedGrants})`);

  const { rows: [wl] } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM wallet_ledger WHERE user_id = ANY($1::uuid[])`, [users]);
  console.log(`wallet_ledger for all 3: ${wl.c} (expect 0 -- award_points=0)`);

  const { rows: [u3g] } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM campaign_grants
     WHERE campaign_id='prod-9b-firstn' AND user_id=$1`, [users[2]]);
  console.log(`USER3 grant count: ${u3g.c} (expect 0 -- rank ${got[2]} > quota ${quota})`);

  const pass = consecutive && grants.length===expectedGrants && camp.granted_count===expectedGrants && wl.c===0 && u3g.c===0;
  console.log(`\nSTEP 3 ${pass ? 'PASS' : 'FAIL'}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
JS

# ── Deactivate first-N campaign before Part 2 so P4 signup won't trigger it ──
echo ""; echo "▶ Deactivating prod-9b-firstn before Part 2..."
HTTP=$(curl -s -o /tmp/9b_d1 -w "%{http_code}" \
  -X PATCH "$BASE/admin/campaigns/prod-9b-firstn" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: $ADMIN_KEY" \
  -d '{"active":false}')
[ "$HTTP" != "200" ] && { echo "FAIL $HTTP: $(cat /tmp/9b_d1)"; exit 1; }
echo "  active=$(jq '.active' /tmp/9b_d1) (expect false)"

echo ""; echo "Part 1 complete. Press Enter to continue to daily-first-N or Ctrl+C."; read -r

# ═════════════════════════════════════════════════════════════════════════════
# PART 2 — DAILY-FIRST-N TEST
# ═════════════════════════════════════════════════════════════════════════════

# ── Step 4: Create prod-9b-daily via POST /admin/campaigns ───────────────────
echo ""; echo "▶ STEP 4: Create prod-9b-daily campaign"
STARTS=$(node -e "console.log(new Date().toISOString())")
ENDS=$(node   -e "console.log(new Date(Date.now()+3*3600000).toISOString())")

HTTP=$(curl -s -o /tmp/9b_c2 -w "%{http_code}" \
  -X POST "$BASE/admin/campaigns" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: $ADMIN_KEY" \
  -d "$(jq -n \
        --arg id "prod-9b-daily" \
        --arg nm "Prod 9B Daily-First-N" \
        --arg s  "$STARTS" \
        --arg e  "$ENDS" \
        '{id:$id,name:$nm,type:"daily_first_n",starts_at:$s,ends_at:$e,award_points:0,daily_quota:1}')")
[ "$HTTP" != "201" ] && {
  echo "FAIL $HTTP: $(cat /tmp/9b_c2)"
  echo "(If campaign exists from a prior run, DELETE it via direct SQL first)"
  exit 1
}
echo "  OK  id=$(jq -r .id /tmp/9b_c2)  daily_quota=$(jq .daily_quota /tmp/9b_c2)  award_points=$(jq .award_points /tmp/9b_c2)"
# Same activation pattern — DB default is false
HTTP=$(curl -s -o /tmp/9b_act2 -w "%{http_code}" \
  -X PATCH "$BASE/admin/campaigns/prod-9b-daily" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: $ADMIN_KEY" \
  -d '{"active":true}')
[ "$HTTP" != "200" ] && { echo "FAIL activation $HTTP: $(cat /tmp/9b_act2)"; exit 1; }
echo "  activated: active=$(jq '.active' /tmp/9b_act2) (expect true)"

# ── Step 5: fc7dac6d — OTP bypass → acquire JWT ──────────────────────────────
echo ""; echo "▶ STEP 5: fc7dac6d — OTP bypass → POST /api/auth/otp/verify"
seed_otp "$FC7_PHONE"
FC7_RESP=$(verify_otp "$FC7_PHONE")
FC7_TOKEN=$(echo "$FC7_RESP" | jq -r '.token')
export FC7_ID
FC7_ID=$(echo "$FC7_RESP" | jq -r '.user.id')
FC7_IS_NEW=$(echo "$FC7_RESP" | jq -r '.isNewUser')
echo "  fc7dac6d id: $FC7_ID"
echo "  isNewUser: $FC7_IS_NEW (expect false — hook must NOT re-fire for existing user)"
[ "$FC7_IS_NEW" = "true" ] && echo "  WARNING: isNewUser=true — fc7dac6d treated as new, signup hook fired"

# ── Step 6: fc7dac6d — real puzzle submissions ───────────────────────────────
echo ""; echo "▶ STEP 6: fc7dac6d — POST /api/puzzles/result (all sub-stage 1.1 puzzles)"
submit_puzzles "$FC7_TOKEN"

# ── Step 7: fc7dac6d — POST /api/substage/complete ───────────────────────────
echo ""; echo "▶ STEP 7: fc7dac6d — POST /api/substage/complete (expect rank 1, grant written, 0 campaign pts)"
HTTP=$(curl -s -o /tmp/9b_cmp1 -w "%{http_code}" \
  -X POST "$BASE/api/substage/complete" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FC7_TOKEN" \
  -d '{"sub_stage_id":"1.1"}')
[ "$HTTP" != "200" ] && { echo "FAIL $HTTP: $(cat /tmp/9b_cmp1)"; exit 1; }
echo "  mastered:       $(jq -r .mastered       /tmp/9b_cmp1)  (expect true)"
echo "  points_awarded: $(jq -r .points_awarded  /tmp/9b_cmp1)  (expect ssc+pfb from pre-flight)"
echo "  balance:        $(jq -r .balance          /tmp/9b_cmp1)"

# ── Step 8: Verify fc7dac6d daily-first-N state ──────────────────────────────
echo ""; echo "▶ STEP 8: Verify fc7dac6d got rank 1 + campaign_grants row"
railway run npx ts-node --transpile-only << 'JS'
const pool = require('./src/lib/db').default;
(async () => {
  const id = process.env.FC7_ID;
  const { rows: [dn] } = await pool.query(
    `SELECT rank FROM daily_first_n WHERE user_id=$1 AND campaign_id='prod-9b-daily'`, [id]
  );
  console.log('daily_first_n rank:', dn?.rank ?? 'NONE', ' (expect 1)');

  const { rows: [grant] } = await pool.query(
    `SELECT award_points FROM campaign_grants WHERE user_id=$1 AND campaign_id='prod-9b-daily'`, [id]
  );
  console.log('campaign_grants award_points:', grant?.award_points ?? 'NONE', ' (expect 0)');

  const { rows: [wl] } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM wallet_ledger WHERE idempotency_key=$1`,
    [`promo:prod-9b-daily:${id}`]
  );
  console.log('wallet_ledger campaign rows:', wl.c, ' (expect 0 — award_points=0)');

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
JS

# ── Step 9: Create P4 via OTP bypass, submit puzzles, complete sub-stage ──────
echo ""; echo "▶ STEP 9: P4 — OTP bypass signup → puzzles → substage/complete (rank 2, no grant)"

P4_PHONE=$(railway run npx ts-node --transpile-only << 'JS' 2>/dev/null
const bcrypt = require('bcrypt');
const pool   = require('./src/lib/db').default;
const { randomInt } = require('crypto');
(async () => {
  const phone = '+91' + randomInt(6_000_000_000, 9_999_999_999);
  await pool.query('DELETE FROM otp_codes WHERE phone=$1', [phone]);
  await pool.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
    [phone, await bcrypt.hash('999999', 10)]
  );
  console.log(phone);
  await pool.end();
})().catch(e => { process.stderr.write(String(e)+'\n'); process.exit(1); });
JS
)

P4_RESP=$(verify_otp "$P4_PHONE")
P4_TOKEN=$(echo "$P4_RESP" | jq -r '.token')
export P4_ID
P4_ID=$(echo "$P4_RESP" | jq -r '.user.id')
echo "  P4 id: $P4_ID  isNewUser=$(echo "$P4_RESP"|jq -r .isNewUser)"
echo "  (prod-9b-firstn is inactive — signup hook fires but finds no first_n campaigns, returns early)"

echo "  P4 puzzle submissions:"
submit_puzzles "$P4_TOKEN"

HTTP=$(curl -s -o /tmp/9b_p4cmp -w "%{http_code}" \
  -X POST "$BASE/api/substage/complete" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $P4_TOKEN" \
  -d '{"sub_stage_id":"1.1"}')
[ "$HTTP" != "200" ] && { echo "FAIL $HTTP: $(cat /tmp/9b_p4cmp)"; exit 1; }
echo "  P4 complete: mastered=$(jq -r .mastered /tmp/9b_p4cmp)  points_awarded=$(jq -r .points_awarded /tmp/9b_p4cmp)"

# ── Step 10: Full daily-first-N DB verification ───────────────────────────────
echo ""; echo "▶ STEP 10: Full daily-first-N DB state"
railway run npx ts-node --transpile-only << 'JS'
const pool = require('./src/lib/db').default;
(async () => {
  const fc7 = process.env.FC7_ID;
  const p4  = process.env.P4_ID;

  const { rows: dn } = await pool.query(
    `SELECT user_id, rank FROM daily_first_n
     WHERE campaign_id='prod-9b-daily' ORDER BY rank`
  );
  console.log(`\ndaily_first_n rows (${dn.length}, expect 2):`);
  dn.forEach(r => {
    const who = r.user_id===fc7?' ← fc7dac6d':r.user_id===p4?' ← P4':'';
    console.log(`  rank ${r.rank}: ${r.user_id.slice(0,8)}${who}`);
  });

  const { rows: grants } = await pool.query(
    `SELECT user_id, award_points FROM campaign_grants WHERE campaign_id='prod-9b-daily'`
  );
  console.log(`\ncampaign_grants (${grants.length}, expect 1 — fc7dac6d only):`);
  grants.forEach(g => {
    const who = g.user_id===fc7?' ← fc7dac6d (correct)':g.user_id===p4?' ← P4 (WRONG)':'';
    console.log(`  ${g.user_id.slice(0,8)}  award_points=${g.award_points}${who}`);
  });

  const { rows: [p4g] } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM campaign_grants
     WHERE user_id=$1 AND campaign_id='prod-9b-daily'`, [p4]
  );
  console.log(`\nP4 grant count: ${p4g.c} (expect 0 — rank 2 > daily_quota 1)`);

  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
JS

# ═════════════════════════════════════════════════════════════════════════════
# PART 3 — IDEMPOTENCY CHECK
# ═════════════════════════════════════════════════════════════════════════════

echo ""; echo "▶ STEP 11: Idempotency — fc7dac6d calls /api/substage/complete again (alreadyAwarded path)"
HTTP=$(curl -s -o /tmp/9b_idem -w "%{http_code}" \
  -X POST "$BASE/api/substage/complete" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FC7_TOKEN" \
  -d '{"sub_stage_id":"1.1"}')
[ "$HTTP" != "200" ] && { echo "FAIL $HTTP: $(cat /tmp/9b_idem)"; exit 1; }
echo "  mastered:       $(jq -r .mastered       /tmp/9b_idem)  (expect true)"
echo "  points_awarded: $(jq -r .points_awarded  /tmp/9b_idem)  (expect 0 — alreadyAwarded)"

railway run npx ts-node --transpile-only << 'JS'
const pool = require('./src/lib/db').default;
(async () => {
  const id = process.env.FC7_ID;
  const [dn, gr] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS c FROM daily_first_n
       WHERE user_id=$1 AND campaign_id='prod-9b-daily'`, [id]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS c FROM campaign_grants
       WHERE user_id=$1 AND campaign_id='prod-9b-daily'`, [id]
    ),
  ]);
  console.log('daily_first_n rows for fc7dac6d:', dn.rows[0].c, ' (expect 1 — idempotent)');
  console.log('campaign_grants for fc7dac6d:   ', gr.rows[0].c, ' (expect 1 — idempotent)');
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
JS

# ═════════════════════════════════════════════════════════════════════════════
# CLEANUP
# ═════════════════════════════════════════════════════════════════════════════

echo ""; echo "▶ STEP 12: Deactivate prod-9b-daily"
HTTP=$(curl -s -o /tmp/9b_d2 -w "%{http_code}" \
  -X PATCH "$BASE/admin/campaigns/prod-9b-daily" \
  -H "Content-Type: application/json" \
  -H "x-admin-key: $ADMIN_KEY" \
  -d '{"active":false}')
[ "$HTTP" != "200" ] && { echo "FAIL $HTTP: $(cat /tmp/9b_d2)"; exit 1; }
echo "  active=$(jq '.active' /tmp/9b_d2) (expect false)"

echo ""; echo "▶ STEP 13: Delete USER1/USER2/USER3 (confirmed zero wallet_ledger rows)"
railway run npx ts-node --transpile-only << 'JS'
const pool = require('./src/lib/db').default;
(async () => {
  const users  = process.env.FIRSTN_IDS.split(',');
  const phones = process.env.FIRSTN_PHONES.split(',');

  const { rows: [wl] } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM wallet_ledger WHERE user_id = ANY($1::uuid[])`,
    [users]
  );
  if (wl.c > 0) throw new Error(`ABORT: ${wl.c} unexpected wallet_ledger rows — not safe to delete`);

  await pool.query(`DELETE FROM campaign_grants WHERE user_id = ANY($1::uuid[])`, [users]);
  await pool.query(`DELETE FROM first_n_signups  WHERE user_id = ANY($1::uuid[])`, [users]);
  await pool.query(`DELETE FROM otp_codes WHERE phone = ANY($1::text[])`, [phones]);
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [users]);
  console.log(`Deleted ${rowCount}/3 users (USER1/USER2/USER3) — clean`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
JS

echo ""
echo "═══ VERIFICATION COMPLETE ═══"
echo "fc7dac6d ($FC7_ID): PERMANENT — wallet_ledger rows from puzzle results"
echo "P4       ($P4_ID)  : PERMANENT — wallet_ledger rows from puzzle results"
echo "prod-9b-firstn : deactivated after Part 1"
echo "prod-9b-daily  : deactivated after Part 3"
