import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import paymentsRouter from "./payments";
import sessionsRouter from "./sessions";
import apiKeysRouter from "./apikeys";
import vaultRouter from "./vault";
import walletRouter from "./wallet";
import liquidityRouter from "./liquidity";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(walletRouter);
router.use(sessionsRouter);
router.use(paymentsRouter);
router.use(apiKeysRouter);
router.use(vaultRouter);
router.use(liquidityRouter);

export default router;
