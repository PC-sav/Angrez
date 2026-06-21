import express from "express";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import routes from "./routes/index";
import adminRouter from "./routes/admin";

const app = express();

app.use(helmet());
app.use(cors());

// Cashfree signs webhooks over the RAW request body.  Capture it BEFORE
// express.json() consumes the stream.  body-parser skips a route when
// req._body is already true, so subsequent json() calls are no-ops here.
app.use("/api/payments/webhook", express.raw({ type: "*/*" }));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  "/audio",
  express.static(path.join(process.cwd(), "assets", "audio"), {
    maxAge: "7d",
    fallthrough: false,
  })
);

app.use("/api", routes);
app.use("/admin", adminRouter);

export default app;