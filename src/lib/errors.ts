export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errResponse(code: string, message: string) {
  return { error: { code, message } };
}

// Node.js network error codes that indicate the DB is temporarily unreachable.
const TRANSIENT_NODE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND"]);

// Postgres server-level codes that indicate a connection-level failure.
const TRANSIENT_PG_CODES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now (server starting up)
  "08006", // connection_failure
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
]);

/**
 * Returns true for errors that indicate a transient infrastructure failure
 * (pool exhaustion, network drop, server restart) — these should become 503.
 * Logic errors (bad SQL, unique violations, etc.) return false and stay 500.
 */
export function isConnectionError(err: unknown): boolean {
  if (err instanceof Error) {
    // pg-pool exhaustion: "timeout exceeded when trying to connect"
    if (/timeout exceeded/i.test(err.message)) return true;
    // Node.js network errors
    const nodeCode = (err as NodeJS.ErrnoException).code;
    if (nodeCode && TRANSIENT_NODE_CODES.has(nodeCode)) return true;
  }
  // Postgres wire-level connection failure codes
  const pgCode = (err as { code?: string }).code;
  if (typeof pgCode === "string" && TRANSIENT_PG_CODES.has(pgCode)) return true;
  return false;
}
