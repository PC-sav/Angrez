import { env } from "../../config/env";
import type { SmsProvider } from "./provider";
import { StubSmsProvider } from "./stub";
import { ExotelSmsProvider } from "./exotel";

function makeSmsProvider(): SmsProvider {
  if (env.smsProvider === "exotel") return new ExotelSmsProvider();
  return new StubSmsProvider();
}

// Singleton — created once at startup
export const sms: SmsProvider = makeSmsProvider();
