import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();
const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({
  origin(origin, callback) {
    if (!origin || process.env.NODE_ENV !== "production" || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("origin not allowed"));
  },
  allowedHeaders: ["Authorization", "Content-Type", "X-API-Key", "X-Checkout-Token"],
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
}));
app.use(express.json({ limit: "32kb" }));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
