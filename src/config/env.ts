import "dotenv/config";

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

export const env = {
  nodeEnv: optional("NODE_ENV", "development"),
  port: parseInt(optional("PORT", "3000"), 10),
  appBaseUrl: optional("APP_BASE_URL", "http://localhost:3000"),
  jwtSecret: optional("JWT_SECRET"),
  jwtExpiresIn: optional("JWT_EXPIRES_IN", "7d"),

  supabaseUrl: optional("SUPABASE_URL"),
  supabaseAnonKey: optional("SUPABASE_ANON_KEY"),
  supabaseServiceRoleKey: optional("SUPABASE_SERVICE_ROLE_KEY"),
  databaseUrl: optional("DATABASE_URL"),

  googleOauthClientId: optional("GOOGLE_OAUTH_CLIENT_ID"),
  googleOauthClientSecret: optional("GOOGLE_OAUTH_CLIENT_SECRET"),

  otpStubMode: optional("OTP_STUB_MODE", "true") === "true",
  otpLength: parseInt(optional("OTP_LENGTH", "6"), 10),
  otpTtlSeconds: parseInt(optional("OTP_TTL_SECONDS", "300"), 10),
  otpMaxAttempts: parseInt(optional("OTP_MAX_ATTEMPTS", "5"), 10),
} as const;
