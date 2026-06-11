import { Pool } from "pg";
import { env } from "../config/env";

const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 5,
  connectionTimeoutMillis: 5000,
  ssl: env.databaseUrl.includes("supabase.co") ? { rejectUnauthorized: false } : undefined,
});

export default pool;
