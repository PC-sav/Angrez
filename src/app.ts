import express from "express";
import cors from "cors";
import helmet from "helmet";
import routes from "./routes/index";
import adminRouter from "./routes/admin";

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", routes);
app.use("/admin", adminRouter);

export default app;
