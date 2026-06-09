import { Router, Request, Response } from "express";
import { version } from "../../package.json";
import authRouter from "./auth";

const router = Router();

const startedAt = Date.now();

router.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    version,
    env: process.env.NODE_ENV ?? "development",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
});

router.use("/auth", authRouter);

export default router;
