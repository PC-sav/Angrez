import "./config/env"; // load .env first
import app from "./app";
import { env } from "./config/env";

const _diagUrl = new URL(process.env.DATABASE_URL!);
console.log("[diag] DB target:", _diagUrl.hostname, _diagUrl.port);

app.listen(env.port, () => {
  console.log(`[angrez] listening on port ${env.port} (${env.nodeEnv})`);
});
