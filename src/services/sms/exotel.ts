import type { SmsProvider } from "./provider";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";

const SEND_TIMEOUT_MS = 10_000;

const REQUIRED_VARS = [
  ["exotelApiKey", "EXOTEL_API_KEY"],
  ["exotelApiToken", "EXOTEL_API_TOKEN"],
  ["exotelSid", "EXOTEL_SID"],
  ["exotelSubdomain", "EXOTEL_SUBDOMAIN"],
  ["exotelSenderId", "EXOTEL_SENDER_ID"],
  ["exotelDltEntityId", "EXOTEL_DLT_ENTITY_ID"],
  ["exotelDltTemplateId", "EXOTEL_DLT_TEMPLATE_ID"],
  ["otpSmsTemplate", "OTP_SMS_TEMPLATE"],
] as const;

export class ExotelSmsProvider implements SmsProvider {
  private readonly sendUrl: string;
  private readonly authHeader: string;

  constructor() {
    const missing = REQUIRED_VARS.filter(([envKey]) => env[envKey] === "").map(([, name]) => name);
    if (missing.length > 0) {
      throw new Error(`ExotelSmsProvider: missing required env var(s): ${missing.join(", ")}`);
    }
    if (!env.otpSmsTemplate.includes("{#var#}")) {
      throw new Error(
        "ExotelSmsProvider: OTP_SMS_TEMPLATE must contain a {#var#} placeholder for the OTP code",
      );
    }

    this.sendUrl = `https://${env.exotelSubdomain}/v1/Accounts/${env.exotelSid}/Sms/send`;
    // Basic Auth via header — credentials must never be embedded in the URL (they leak into logs).
    this.authHeader = `Basic ${Buffer.from(`${env.exotelApiKey}:${env.exotelApiToken}`).toString("base64")}`;
  }

  async sendOtp(phone: string, code: string): Promise<{ devOtp?: string }> {
    const body = env.otpSmsTemplate.replace("{#var#}", code);

    const form = new URLSearchParams({
      From: env.exotelSenderId,
      // phone arrives already normalised to +91XXXXXXXXXX by requestOtp; Exotel accepts this format.
      To: phone,
      Body: body,
      DltEntityId: env.exotelDltEntityId,
      DltTemplateId: env.exotelDltTemplateId,
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(this.sendUrl, {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
        signal: controller.signal,
      });
    } catch (err) {
      console.error("[exotel] send request failed (network/timeout):", err);
      throw new AppError(
        "OTP_SEND_FAILED",
        "OTP भेजने में दिक्कत हुई — कुछ देर बाद कोशिश करें।",
        502,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "<unreadable body>");
      console.error(`[exotel] send failed, status=${res.status} body=${errorBody}`);
      throw new AppError(
        "OTP_SEND_FAILED",
        "OTP भेजने में दिक्कत हुई — कुछ देर बाद कोशिश करें।",
        502,
      );
    }

    // Exotel 2xx means accepted/queued, not delivered — the response body carries
    // SmsSid + DetailedStatus (e.g. PENDING_TO_OPERATOR), which is the first breadcrumb
    // when a DLT template mismatch makes carriers silently drop the SMS.
    const okBody = await res.text().catch(() => "<unreadable body>");
    console.log(`[exotel] send accepted, status=${res.status} body=${okBody.slice(0, 500)}`);

    return {};
  }
}
