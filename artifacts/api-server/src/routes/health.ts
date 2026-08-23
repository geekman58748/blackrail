import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json({ ...data, v: "5", erConfigured: !!(process.env.SERVER_KEYPAIR && process.env.USDC_MINT) });
});

export default router;
