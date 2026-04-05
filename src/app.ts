import "dotenv/config";
import express from "express";
import logger from "./services/logger.service";
import db from "./services/database.service";
import router from "./routes";

const PORT = process.env.PORT || 3000;
const app = express();

app.use(express.json());
app.use("/api", router);

async function main() {
  await db.connect();

  app.listen(PORT, () => {
    logger.success("APP", `Server listening on http://localhost:${PORT}`);
  });
}

main();
