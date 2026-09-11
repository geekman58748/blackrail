import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json({ ...data, v: "7-liquidity", erConfigured: !!(process.env.SERVER_KEYPAIR && process.env.USDC_MINT), flwConfigured: !!process.env.FLUTTERWAVE_SECRET_KEY });
});

export default router;
