import pool from "../lib/db";

export interface User {
  id: string;
  phone: string | null;
  email: string | null;
  name: string | null;
  language: string;
  level: number;
  goal: string | null;
  google_id: string | null;
  created_at: Date;
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    "SELECT * FROM users WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

export async function findUserByPhone(phone: string): Promise<User | null> {
  const { rows } = await pool.query<User>(
    "SELECT * FROM users WHERE phone = $1",
    [phone],
  );
  return rows[0] ?? null;
}

/** Find-or-create a user for phone-based (OTP) auth. */
export async function findOrCreateByPhone(
  phone: string,
): Promise<{ user: User; isNewUser: boolean }> {
  const existing = await findUserByPhone(phone);
  if (existing) return { user: existing, isNewUser: false };

  const { rows } = await pool.query<User>(
    "INSERT INTO users (phone) VALUES ($1) RETURNING *",
    [phone],
  );
  return { user: rows[0], isNewUser: true };
}

/** Find-or-create a user for Google auth. Links by google_id, then email, then creates. */
export async function findOrCreateByGoogle(params: {
  googleId: string;
  email: string;
  name?: string;
}): Promise<{ user: User; isNewUser: boolean }> {
  const { googleId, email, name } = params;

  // 1 — already linked
  const byGoogleId = await pool.query<User>(
    "SELECT * FROM users WHERE google_id = $1",
    [googleId],
  );
  if (byGoogleId.rows[0]) return { user: byGoogleId.rows[0], isNewUser: false };

  // 2 — existing OTP user with same email → link
  const byEmail = await pool.query<User>(
    "SELECT * FROM users WHERE email = $1",
    [email],
  );
  if (byEmail.rows[0]) {
    const { rows } = await pool.query<User>(
      `UPDATE users
          SET google_id = $1, name = COALESCE(name, $2)
        WHERE id = $3
        RETURNING *`,
      [googleId, name ?? null, byEmail.rows[0].id],
    );
    return { user: rows[0], isNewUser: false };
  }

  // 3 — brand new user
  const { rows } = await pool.query<User>(
    `INSERT INTO users (google_id, email, name) VALUES ($1, $2, $3) RETURNING *`,
    [googleId, email, name ?? null],
  );
  return { user: rows[0], isNewUser: true };
}
