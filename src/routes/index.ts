import { Router, Request, Response } from "express";
import { version } from "../../package.json";
import pool from "../lib/db";
import authRouter from "./auth";
import contentRouter from "./content";
import learningRouter from "./learning";
import walletRouter from "./wallet";
import campaignsRouter from "./campaigns";
import paymentsRouter from "./payments";
import subscriptionRouter from "./subscription";
import founderRouter from "./founder";
import plansRouter from "./plans";
import referralRouter from "./referral";
import webhooksRouter from "./webhooks";

const router = Router();

const startedAt = Date.now();

router.get("/health", async (_req: Request, res: Response) => {
  let db: "ok" | "unreachable" = "ok";
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    console.error("[health] DB check failed:", err);
    db = "unreachable";
  }

  res.status(db === "ok" ? 200 : 503).json({
    status: db === "ok" ? "ok" : "degraded",
    version,
    env: process.env.NODE_ENV ?? "development",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
    db,
  });
});

router.use("/auth", authRouter);
router.use("/content", contentRouter);
router.use("/wallet", walletRouter);
router.use("/campaigns", campaignsRouter);
router.use("/payments", paymentsRouter);
router.use("/subscription", subscriptionRouter);
router.use("/founder", founderRouter);
router.use("/plans", plansRouter);
router.use("/referral", referralRouter);
router.use("/webhooks", webhooksRouter);
router.use("/", learningRouter);

export default router;
