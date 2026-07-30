import { AccessLogger } from "./access-log.js";
import { loadConfig } from "./config.js";
import { createOriginServer } from "./server.js";
import { ImageStore } from "./store.js";

async function main() {
  const config = loadConfig();
  const store = await new ImageStore(config).init();
  const accessLogger = await new AccessLogger(config.accessLogDir).init();
  const server = createOriginServer({ config, store, accessLogger });

  const purge = async () => {
    try {
      const purged = await store.purgeExpired();
      if (purged) console.info(JSON.stringify({ event: "trash_purge", purged }));
    } catch (error) {
      console.error("scheduled trash purge failed", error);
    }
  };
  const compressLogs = async () => {
    try {
      await accessLogger.compressOld();
    } catch (error) {
      console.error("scheduled access log compression failed", error);
    }
  };
  await purge();
  const purgeTimer = setInterval(purge, config.purgeIntervalMs);
  const logTimer = setInterval(compressLogs, 24 * 60 * 60 * 1000);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => {
      server.off("error", reject);
      console.info(JSON.stringify({
        event: "started",
        host: config.host,
        port: config.port,
        data_dir: config.dataDir,
        access_log_dir: config.accessLogDir,
      }));
      resolve();
    });
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(purgeTimer);
    clearInterval(logTimer);
    const deadline = setTimeout(() => {
      server.closeAllConnections();
    }, config.shutdownTimeoutMs);
    deadline.unref();
    try {
      await new Promise((resolve) => server.close(resolve));
      await accessLogger.close();
      console.info(JSON.stringify({ event: "stopped", signal }));
      process.exitCode = 0;
    } catch (error) {
      console.error("graceful shutdown failed", error);
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error("meme-origin failed", error);
  process.exitCode = 1;
});
