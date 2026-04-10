import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import logger from "./services/logger.service";
import db from "./services/database.service";
import router from "./routes";
import { errorMiddleware } from "./middlewares/error.middleware";

const PORT = process.env.PORT || 8000;
const app = express();

app.use(cors({
  origin: process.env.CLIENT_URL,
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use("/api", router);
app.use(errorMiddleware);

process.on("uncaughtException", (err) => {
  logger.error("UNCAUGHT", err.message);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("UNHANDLED_REJECTION", String(reason));
});

async function main() {
  await db.connect();

  app.listen(PORT, () => {
    logger.success("APP", `Server listening on http://localhost:${PORT}`);
  });
}

main();
