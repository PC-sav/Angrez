import { OAuth2Client } from "google-auth-library";
import { env } from "../config/env";
import { AppError } from "../lib/errors";

const GOOGLE_TIMEOUT_MS = 5_000;

let client: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (!env.googleClientId) {
    throw new AppError(
      "GOOGLE_NOT_CONFIGURED",
      "Google Sign-In is not configured on this server.",
      501,
    );
  }
  if (!client) client = new OAuth2Client(env.googleClientId);
  return client;
}

export interface GoogleProfile {
  googleId: string;
  email: string;
  name?: string;
}

export async function verifyGoogleToken(idToken: string): Promise<GoogleProfile> {
  const oauth = getClient();

  let ticket;
  try {
    ticket = await Promise.race([
      oauth.verifyIdToken({ idToken, audience: env.googleClientId }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Google auth timed out")), GOOGLE_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Google verification failed";
    throw new AppError("GOOGLE_AUTH_FAILED", msg, 401);
  }

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) {
    throw new AppError("GOOGLE_AUTH_FAILED", "Invalid Google token payload.", 401);
  }

  return { googleId: payload.sub, email: payload.email, name: payload.name };
}
