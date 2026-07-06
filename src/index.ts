import "./config/env"; // load .env first
import app from "./app";
import { env } from "./config/env";

const _diagUrl = new URL(process.env.DATABASE_URL!);
console.log("[diag] DB target:", _diagUrl.hostname, _diagUrl.port);

// Presence-only — never log the values themselves (service-account JSON, audience URL).
console.log("[diag] Google Play env present:", {
  serviceAccountJson: env.googlePlayServiceAccountJson.length > 0,
  packageName: env.googlePlayPackageName.length > 0,
  pubsubAudience: env.googlePlayPubsubAudience.length > 0,
});

app.listen(env.port, () => {
  console.log(`[angrez] listening on port ${env.port} (${env.nodeEnv})`);
});
