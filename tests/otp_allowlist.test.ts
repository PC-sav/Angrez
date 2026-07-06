/**
 * tests/otp_allowlist.test.ts
 *
 * Test-phone allowlist: permanent test numbers + future Play Store reviewer
 * get a fixed OTP code instead of a random one, with the SMS provider never
 * invoked. Inert unless BOTH TEST_PHONE_ALLOWLIST and TEST_PHONE_OTP are set.
 *
 * env.ts reads process.env once at module-load time (a singleton), so
 * exercising different env configurations requires vi.stubEnv + a fresh
 * module instance per test (vi.resetModules + dynamic import) rather than
 * mutating process.env after the module has already been imported.
 */

import "dotenv/config";
import { randomInt } from "crypto";
import bcrypt from "bcrypt";
import { describe, it, expect, afterEach, afterAll, vi } from "vitest";
import appPool from "../src/lib/db";

const FIXED_OTP = "482913";
const usedPhones: string[] = [];

function freshTestPhone(): string {
  const phone = `+91${randomInt(6_000_000_000, 9_999_999_999)}`;
  usedPhones.push(phone);
  return phone;
}

async function freshOtpModule() {
  vi.resetModules();
  return import("../src/services/otp");
}

async function codeHashFor(phone: string): Promise<string> {
  const { rows } = await appPool.query<{ code_hash: string }>(
    "SELECT code_hash FROM otp_codes WHERE phone = $1 ORDER BY created_at DESC LIMIT 1",
    [phone],
  );
  return rows[0].code_hash;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await appPool.query("DELETE FROM otp_codes WHERE phone = ANY($1::text[])", [usedPhones]);
  await appPool.query("DELETE FROM users WHERE phone = ANY($1::text[])", [usedPhones]);
  await appPool.end();
});

describe("test-phone allowlist — active (both env vars set)", () => {
  it("allowlisted number: requestOtp uses the fixed code, sms provider skipped, verifyOtp accepts it end-to-end", async () => {
    const phone = freshTestPhone();
    vi.stubEnv("TEST_PHONE_ALLOWLIST", phone);
    vi.stubEnv("TEST_PHONE_OTP", FIXED_OTP);
    const { requestOtp, verifyOtp } = await freshOtpModule();

    const result = await requestOtp(phone);
    expect(result).toEqual({}); // no devOtp — sms.sendOtp() was never called

    const verifyResult = await verifyOtp(phone, FIXED_OTP);
    expect(verifyResult.token).toBeTruthy();
  });

  it("allowlist parsing tolerates whitespace around commas", async () => {
    const phone = freshTestPhone();
    const decoyPhone = freshTestPhone();
    vi.stubEnv("TEST_PHONE_ALLOWLIST", `  ${decoyPhone}   ,   ${phone}  `);
    vi.stubEnv("TEST_PHONE_OTP", FIXED_OTP);
    const { requestOtp, verifyOtp } = await freshOtpModule();

    await requestOtp(phone);
    const verifyResult = await verifyOtp(phone, FIXED_OTP);
    expect(verifyResult.token).toBeTruthy();
  });

  it("non-allowlisted number is unaffected: fixed code is NOT what got hashed", async () => {
    const allowlisted = freshTestPhone();
    const other = freshTestPhone();
    vi.stubEnv("TEST_PHONE_ALLOWLIST", allowlisted);
    vi.stubEnv("TEST_PHONE_OTP", FIXED_OTP);
    const { requestOtp, verifyOtp } = await freshOtpModule();

    await requestOtp(other);

    const hash = await codeHashFor(other);
    expect(await bcrypt.compare(FIXED_OTP, hash)).toBe(false);

    await expect(verifyOtp(other, FIXED_OTP)).rejects.toThrow(/Invalid or expired OTP/);
  });
});

describe("test-phone allowlist — inert when either var is unset", () => {
  it("both unset: an allowlist-shaped number behaves like any other number", async () => {
    const phone = freshTestPhone();
    vi.stubEnv("TEST_PHONE_ALLOWLIST", "");
    vi.stubEnv("TEST_PHONE_OTP", "");
    const { requestOtp } = await freshOtpModule();

    await requestOtp(phone);
    const hash = await codeHashFor(phone);
    expect(await bcrypt.compare(FIXED_OTP, hash)).toBe(false);
  });

  it("allowlist set but TEST_PHONE_OTP unset: feature inert", async () => {
    const phone = freshTestPhone();
    vi.stubEnv("TEST_PHONE_ALLOWLIST", phone);
    vi.stubEnv("TEST_PHONE_OTP", "");
    const { requestOtp } = await freshOtpModule();

    await requestOtp(phone);
    const hash = await codeHashFor(phone);
    expect(await bcrypt.compare(FIXED_OTP, hash)).toBe(false);
  });

  it("TEST_PHONE_OTP set but allowlist unset: feature inert", async () => {
    const phone = freshTestPhone();
    vi.stubEnv("TEST_PHONE_ALLOWLIST", "");
    vi.stubEnv("TEST_PHONE_OTP", FIXED_OTP);
    const { requestOtp } = await freshOtpModule();

    await requestOtp(phone);
    const hash = await codeHashFor(phone);
    expect(await bcrypt.compare(FIXED_OTP, hash)).toBe(false);
  });
});
