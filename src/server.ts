import { config } from "./config.js";
import { prisma } from "./db.js";
import { logger } from "./logger.js";
import { createApp } from "./api/app.js";
import { Scheduler } from "./services/scheduler.js";

const app = createApp();
const scheduler = new Scheduler();
const server = app.listen(config.PORT, async () => {
  logger.info({ event: "server_started", port: config.PORT, tradingMode: "live", jupiterApiPlan: config.JUPITER_API_PLAN });
  try {
    await scheduler.start();
  } catch (error) {
    logger.fatal({ event: "scheduler_start_failed", error: error instanceof Error ? error.message : String(error) });
    await shutdown(1);
  }
});

let shuttingDown = false;
async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: "server_stopping" });
  await scheduler.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
  process.exit(exitCode);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("unhandledRejection", (error) => logger.error({ event: "unhandled_rejection", error }));
process.on("uncaughtException", (error) => {
  logger.fatal({ event: "uncaught_exception", error });
  void shutdown(1);
});
