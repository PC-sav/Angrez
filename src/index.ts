import "./config/env"; // load .env first
import app from "./app";
import { env } from "./config/env";

app.listen(env.port, () => {
  console.log(`[angrez] listening on port ${env.port} (${env.nodeEnv})`);
});
