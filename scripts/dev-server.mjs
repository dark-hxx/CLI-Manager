import http from "node:http";
import { createServer } from "vite";

const DEV_PORT = 1420;
const DEV_HOST = "127.0.0.1";
const DEV_URL = `http://${DEV_HOST}:${DEV_PORT}`;
const SERVER_PROBE_TIMEOUT_MS = 15_000;

const requestIndex = () =>
  new Promise((resolve) => {
    const request = http.get(DEV_URL, { timeout: SERVER_PROBE_TIMEOUT_MS }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ available: true, statusCode: response.statusCode ?? 0, body });
      });
    });

    request.on("timeout", () => {
      request.destroy();
      resolve({ available: true, statusCode: 0, body: "" });
    });
    request.on("error", (error) => {
      resolve({ available: error.code !== "ECONNREFUSED", statusCode: 0, body: "" });
    });
  });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parentPid = process.ppid;
let close = async () => process.exit(0);

const closeOnSignal = () => {
  void close();
};

process.on("SIGINT", closeOnSignal);
process.on("SIGTERM", closeOnSignal);

setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    void close();
  }
}, 2_000).unref();

const currentServer = await requestIndex();

if (currentServer.available) {
  if (
    currentServer.statusCode >= 200 &&
    currentServer.statusCode < 500 &&
    currentServer.body.includes("<title>CLI-Manager</title>") &&
    currentServer.body.includes("/src/main.tsx")
  ) {
    console.log(`Reusing existing CLI-Manager dev server at ${DEV_URL}`);
    console.log("Press Ctrl+C to stop waiting. The existing dev server process is unchanged.");
    while (true) {
      await sleep(60_000);
    }
  }

  console.error(`Port ${DEV_PORT} is already in use, but it does not look like CLI-Manager's Vite dev server.`);
  console.error("Stop the process using that port, then run the dev command again.");
  process.exit(1);
}

const server = await createServer({
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    strictPort: true,
  },
});
await server.listen();
server.printUrls();
server.bindCLIShortcuts({ print: true });

close = async () => {
  await server.close();
  process.exit(0);
};
