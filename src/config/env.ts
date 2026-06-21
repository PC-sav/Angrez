import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback = ""): string {
  const v = process.env[key];
  return v != null && v !== "" ? v : fallback;
}

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  port: parseInt(optional("PORT", "3000"), 10),
  appBaseUrl: optional("APP_BASE_URL", "http://localhost:3000"),

  // JWT — required; startup will throw if unset
  jwtSecret: required("JWT_SECRET"),
  jwtExpiresIn: optional("JWT_EXPIRES_IN", "30d"),

  // Supabase / Postgres
  supabaseUrl: optional("SUPABASE_URL"),
  supabaseAnonKey: optional("SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: optional("SUPABASE_SERVICE_ROLE_KEY"),
  databaseUrl: required("DATABASE_URL"),

  // Google OAuth
  googleClientId: optional("GOOGLE_CLIENT_ID"),

  // SMS / OTP
  smsProvider: optional("SMS_PROVIDER", "stub") as "stub" | "exotel",
  otpLength: parseInt(optional("OTP_LENGTH", "6"), 10),
  otpTtlSeconds: parseInt(optional("OTP_TTL_SECONDS", "300"), 10),
  otpMaxAttempts: parseInt(optional("OTP_MAX_ATTEMPTS", "5"), 10),
  otpRateLimitCount: parseInt(optional("OTP_RATE_LIMIT_COUNT", "3"), 10),
  otpRateLimitWindowMinutes: parseInt(optional("OTP_RATE_LIMIT_WINDOW_MINUTES", "15"), 10),
  otpResendCooldownSeconds: parseInt(optional("OTP_RESEND_COOLDOWN_SECONDS", "30"), 10),

  // Cashfree Payments — all four are required at startup (Railway Variables)
  cashfreeClientId: required("CASHFREE_CLIENT_ID"),
  cashfreeClientSecret: required("CASHFREE_CLIENT_SECRET"),
  cashfreeWebhookSecret: required("CASHFREE_WEBHOOK_SECRET"),
  cashfreeEnv: optional("CASHFREE_ENV", "sandbox") as "sandbox" | "prod",
} as const;
