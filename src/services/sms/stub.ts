import type { SmsProvider } from "./provider";

export class StubSmsProvider implements SmsProvider {
  async sendOtp(phone: string, code: string): Promise<{ devOtp?: string }> {
    // Always log to server console (never log in production with real codes)
    if (process.env.NODE_ENV !== "production") {
      console.log(`[OTP STUB] code generated, NOT delivered (stub provider) — phone=${phone} code=${code}`);
    } else {
      console.log(`[OTP STUB] code generated, NOT delivered (stub provider) — phone=${phone} (code hidden in production)`);
    }
    // Return the code in the response ONLY outside production so developers
    // can test the full flow without a real SMS gateway.
    return process.env.NODE_ENV !== "production" ? { devOtp: code } : {};
  }
}
