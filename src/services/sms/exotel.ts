import type { SmsProvider } from "./provider";

/** Placeholder — wired in a later week once DLT registration is complete. */
export class ExotelSmsProvider implements SmsProvider {
  async sendOtp(_phone: string, _code: string): Promise<{ devOtp?: string }> {
    throw new Error("ExotelSmsProvider: not wired yet (DLT registration pending)");
  }
}
