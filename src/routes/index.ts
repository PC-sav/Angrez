import { Router, Request, Response } from "express";
import { version } from "../../package.json";
import authRouter from "./auth";
import contentRouter from "./content";
import learningRouter from "./learning";
import walletRouter from "./wallet";
import campaignsRouter from "./campaigns";

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
router.use("/content", contentRouter);
router.use("/wallet", walletRouter);
router.use("/campaigns", campaignsRouter);
router.use("/", learningRouter);

export default router;
