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

// Fails fast in production only.  Dev/test environments (and unrelated test
// suites that import env.ts transitively) aren't blocked before Block 0
// (Play Console setup) has produced real values — mirrors how OTP_STUB_MODE
// lets payment-adjacent config stay optional pre-launch.
function requiredInProd(key: string): string {
  const val = process.env[key];
  if (!val && optional("NODE_ENV", "development") === "production") {
    throw new Error(`Missing required env var: ${key} (required in production)`);
  }
  return val ?? "";
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

  // Test-phone allowlist (permanent test numbers + future Play Store reviewer).
  // Both optional() — if either is unset/empty the feature is inert.
  testPhoneAllowlist: optional("TEST_PHONE_ALLOWLIST"),
  testPhoneOtp: optional("TEST_PHONE_OTP"),

  // Exotel SMS (OTP delivery) — bare optional(); ExotelSmsProvider validates
  // presence itself at construction time and fails loud, naming what's missing.
  exotelApiKey: optional("EXOTEL_API_KEY"),
  exotelApiToken: optional("EXOTEL_API_TOKEN"),
  exotelSid: optional("EXOTEL_SID"),
  exotelSubdomain: optional("EXOTEL_SUBDOMAIN"),
  exotelSenderId: optional("EXOTEL_SENDER_ID"),
  exotelDltEntityId: optional("EXOTEL_DLT_ENTITY_ID"),
  exotelDltTemplateId: optional("EXOTEL_DLT_TEMPLATE_ID"),
  otpSmsTemplate: optional("OTP_SMS_TEMPLATE"),

  // Cashfree Payments — all four are required at startup (Railway Variables)
  cashfreeClientId: required("CASHFREE_CLIENT_ID"),
  cashfreeClientSecret: required("CASHFREE_CLIENT_SECRET"),
  cashfreeWebhookSecret: required("CASHFREE_WEBHOOK_SECRET"),
  cashfreeEnv: optional("CASHFREE_ENV", "sandbox") as "sandbox" | "prod",

  // Google Play Billing (D1c) — service-account JSON is a single-line JSON
  // string env var (no file path); parsed by the Play API client, not here.
  googlePlayServiceAccountJson: requiredInProd("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"),
  googlePlayPackageName: requiredInProd("GOOGLE_PLAY_PACKAGE_NAME"),
  googlePlayPubsubAudience: requiredInProd("GOOGLE_PLAY_PUBSUB_AUDIENCE"),
} as const;
