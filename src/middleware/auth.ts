import type { Request, Response, NextFunction } from "express";
import { verifyJwt } from "../services/jwt";
import { findUserById } from "../services/users";
import { errResponse, isConnectionError } from "../lib/errors";

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res
      .status(401)
      .json(errResponse("UNAUTHORIZED", "Bearer token required."));
    return;
  }

  const token = header.slice(7);
  try {
    const payload = verifyJwt(token);
    const user = await findUserById(payload.sub);
    if (!user) {
      res
        .status(401)
        .json(errResponse("USER_NOT_FOUND", "Token user no longer exists."));
      return;
    }
    req.user = user;
    next();
  } catch (err) {
    if (isConnectionError(err)) {
      res
        .set("Retry-After", "5")
        .status(503)
        .json(errResponse("SERVICE_UNAVAILABLE", "Service temporarily unavailable, please retry."));
      return;
    }
    res
      .status(401)
      .json(errResponse("INVALID_TOKEN", "Invalid or expired token."));
  }
}
