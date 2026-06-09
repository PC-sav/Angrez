import { Router, Request, Response, NextFunction } from "express";
import { normalizePhone, requestOtp, verifyOtp } from "../services/otp";
import { verifyGoogleToken } from "../services/google";
import { findOrCreateByGoogle } from "../services/users";
import { signJwt } from "../services/jwt";
import { requireAuth } from "../middleware/auth";
import { AppError, errResponse } from "../lib/errors";

const router = Router();

// ── Error helper ──────────────────────────────────────────────────────────────

function handleError(err: unknown, res: Response): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json(errResponse(err.code, err.message));
    return;
  }
  console.error("Unhandled auth error:", err);
  res.status(500).json(errResponse("INTERNAL_ERROR", "An unexpected error occurred."));
}

// ── POST /auth/otp/request ────────────────────────────────────────────────────

router.post(
  "/otp/request",
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { phone } = req.body as Record<string, unknown>;
      if (!phone || typeof phone !== "string") {
        res.status(400).json(errResponse("VALIDATION_ERROR", "phone is required."));
        return;
      }

      const normalized = normalizePhone(phone);
      if (!normalized) {
        res
          .status(400)
          .json(
            errResponse(
              "INVALID_PHONE",
              "Invalid phone number. Provide a 10-digit Indian mobile number (6–9 prefix) or +91 format.",
            ),
          );
        return;
      }

      const result = await requestOtp(normalized);
      res.json({ ok: true, ...result });
    } catch (err) {
      handleError(err, res);
    }
  },
);

// ── POST /auth/otp/verify ─────────────────────────────────────────────────────

router.post(
  "/otp/verify",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { phone, code } = req.body as Record<string, unknown>;

      if (!phone || typeof phone !== "string") {
        res.status(400).json(errResponse("VALIDATION_ERROR", "phone is required."));
        return;
      }
      if (!code || typeof code !== "string") {
        res.status(400).json(errResponse("VALIDATION_ERROR", "code is required."));
        return;
      }
      if (!/^\d{6}$/.test(code)) {
        res.status(400).json(errResponse("VALIDATION_ERROR", "code must be 6 digits."));
        return;
      }

      const normalized = normalizePhone(phone);
      if (!normalized) {
        res.status(400).json(errResponse("INVALID_PHONE", "Invalid phone number."));
        return;
      }

      const result = await verifyOtp(normalized, code);
      res.json(result);
    } catch (err) {
      handleError(err, res);
    }
  },
);

// ── POST /auth/google ─────────────────────────────────────────────────────────

router.post(
  "/google",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { idToken } = req.body as Record<string, unknown>;
      if (!idToken || typeof idToken !== "string") {
        res.status(400).json(errResponse("VALIDATION_ERROR", "idToken is required."));
        return;
      }

      const profile = await verifyGoogleToken(idToken);
      const { user, isNewUser } = await findOrCreateByGoogle(profile);
      const token = signJwt({ sub: user.id, phone: user.phone ?? "" });

      res.json({ token, user, isNewUser });
    } catch (err) {
      handleError(err, res);
    }
  },
);

// ── GET /auth/me ──────────────────────────────────────────────────────────────

router.get("/me", requireAuth, (req: Request, res: Response): void => {
  res.json({ user: req.user });
});

export default router;
