import jwt from "jsonwebtoken";
import { env } from "../config/env";

export interface JwtPayload {
  sub: string;   // user UUID
  phone: string; // canonical phone or empty string for Google-only users
}

export function signJwt(payload: JwtPayload): string {
  // expiresIn type requires ms-compatible string (e.g. "30d") or number of seconds
  return jwt.sign(payload, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: env.jwtExpiresIn as `${number}${"s"|"m"|"h"|"d"|"w"}`,
  });
}

export function verifyJwt(token: string): JwtPayload {
  return jwt.verify(token, env.jwtSecret, {
    algorithms: ["HS256"],
  }) as JwtPayload;
}
