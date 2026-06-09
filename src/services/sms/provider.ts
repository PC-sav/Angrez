export interface SmsProvider {
  /** Send an OTP to the given phone. Returns devOtp only in non-production stub mode. */
  sendOtp(phone: string, code: string): Promise<{ devOtp?: string }>;
}
