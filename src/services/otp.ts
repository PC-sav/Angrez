import bcrypt from "bcrypt";
import pool from "../lib/db";
import { env } from "../config/env";
import { AppError } from "../lib/errors";
import { sms } from "./sms/index";
import { signJwt } from "./jwt";
import { findOrCreateByPhone } from "./users";

const BCRYPT_ROUNDS = 10;

// ── Phone normalisation ───────────────────────────────────────────────────────

/**
 * Normalise an Indian phone to +91XXXXXXXXXX.
 * Accepts: +91XXXXXXXXXX, 91XXXXXXXXXX, 0XXXXXXXXXX, XXXXXXXXXX (10-digit).
 * Mobile numbers start with 6–9.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");

  let ten: string | null = null;
  if (digits.length === 10) {
    ten = digits;
  } else if (digits.length === 11 && digits.startsWith("0")) {
    ten = digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith("91")) {
    ten = digits.slice(2);
  } else if (digits.length === 13 && digits.startsWith("091")) {
    ten = digits.slice(3);
  }

  if (!ten || !/^[6-9]\d{9}$/.test(ten)) return null;
  return `+91${ten}`;
}

// ── OTP generation ────────────────────────────────────────────────────────────

function generateCode(length: number): string {
  // Crypto-quality random 6-digit code, zero-padded
  const max = Math.pow(10, length);
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0] % max).padStart(length, "0");
}

// ── Rate-limit helpers ────────────────────────────────────────────────────────

async function assertNotRateLimited(phone: string): Promise<void> {
  // Max N requests per window
  const windowRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM otp_codes
      WHERE phone = $1
        AND created_at > now() - ($2 || ' minutes')::interval`,
    [phone, env.otpRateLimitWindowMinutes],
  );
  if (parseInt(windowRes.rows[0].count, 10) >= env.otpRateLimitCount) {
    throw new AppError(
      "OTP_RATE_LIMIT",
      `Too many OTP requests. Try again in ${env.otpRateLimitWindowMinutes} minutes.`,
      429,
    );
  }

  // Short resend cooldown
  const cooldownRes = await pool.query<{ created_at: Date }>(
    `SELECT created_at FROM otp_codes WHERE phone = $1 ORDER BY created_at DESC LIMIT 1`,
    [phone],
  );
  if (cooldownRes.rows.length > 0) {
    const elapsedSec =
      (Date.now() - new Date(cooldownRes.rows[0].created_at).getTime()) / 1000;
    if (elapsedSec < env.otpResendCooldownSeconds) {
      const waitSec = Math.ceil(env.otpResendCooldownSeconds - elapsedSec);
      throw new AppError(
        "OTP_COOLDOWN",
        `Please wait ${waitSec} second(s) before requesting a new OTP.`,
        429,
      );
    }
  }
}

// ── Test-phone allowlist ──────────────────────────────────────────────────────
// Permanent test numbers + future Play Store reviewer. Inert unless BOTH
// TEST_PHONE_ALLOWLIST and TEST_PHONE_OTP are set (see src/config/env.ts).

const TEST_PHONE_ALLOWLIST = new Set(
  env.testPhoneAllowlist
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean),
);

// ── Public API ────────────────────────────────────────────────────────────────

export async function requestOtp(
  phone: string,
): Promise<{ devOtp?: string }> {
  await assertNotRateLimited(phone);

  const isAllowlistedTestPhone = env.testPhoneOtp !== "" && TEST_PHONE_ALLOWLIST.has(phone);
  const code = isAllowlistedTestPhone ? env.testPhoneOtp : generateCode(env.otpLength);
  const codeHash = await bcrypt.hash(code, BCRYPT_ROUNDS);
  const expiresAt = new Date(Date.now() + env.otpTtlSeconds * 1000);

  await pool.query(
    `INSERT INTO otp_codes (phone, code_hash, expires_at) VALUES ($1, $2, $3)`,
    [phone, codeHash, expiresAt],
  );

  if (isAllowlistedTestPhone) {
    console.log(`[otp] allowlisted test number, fixed code path used: ${phone}`);
    return {};
  }

  return sms.sendOtp(phone, code);
}

export async function verifyOtp(
  phone: string,
  code: string,
): Promise<{ token: string; user: object; isNewUser: boolean }> {
  // Fetch latest unconsumed, unexpired OTP for this phone
  const res = await pool.query<{
    id: string;
    code_hash: string;
    attempts: number;
  }>(
    `SELECT id, code_hash, attempts FROM otp_codes
      WHERE phone = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [phone],
  );

  // Never reveal whether the phone exists — same error for all failures
  const invalid = new AppError("OTP_INVALID", "Invalid or expired OTP.", 401);

  if (res.rows.length === 0) throw invalid;

  const otp = res.rows[0];

  if (otp.attempts >= env.otpMaxAttempts) {
    throw new AppError(
      "OTP_LOCKED",
      "Too many failed attempts. Please request a new OTP.",
      401,
    );
  }

  const match = await bcrypt.compare(code, otp.code_hash);

  if (!match) {
    await pool.query(
      "UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1",
      [otp.id],
    );
    throw invalid;
  }

  // Consume the code atomically — a second call with the same code is rejected
  await pool.query(
    "UPDATE otp_codes SET consumed_at = now() WHERE id = $1",
    [otp.id],
  );

  const { user, isNewUser } = await findOrCreateByPhone(phone);
  const token = signJwt({ sub: user.id, phone: user.phone ?? "" });

  return { token, user, isNewUser };
}
