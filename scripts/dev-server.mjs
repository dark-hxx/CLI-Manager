import http from "node:http";
import { createServer } from "vite";

const DEV_PORT = 1420;
const DEV_HOST = "127.0.0.1";
const DEV_URL = `http://${DEV_HOST}:${DEV_PORT}`;
const SERVER_PROBE_TIMEOUT_MS = 15_000;

// 探测固定回环地址的开发首页，供复用判断而非启动服务。
const requestIndex = () =>
  // 将 HTTP 响应、超时和错误汇合为一次探测结果。
  new Promise((resolve) => {
    // 收到响应后按 UTF-8 收集正文；当前实现没有正文大小上限。
    const request = http.get(DEV_URL, { timeout: SERVER_PROBE_TIMEOUT_MS }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      // 追加响应数据块供页面标记检测。
      response.on("data", (chunk) => {
        body += chunk;
      });
      // 响应结束时返回可达状态、HTTP 状态码和完整正文。
      response.on("end", () => {
        resolve({ available: true, statusCode: response.statusCode ?? 0, body });
      });
    });

    // 超时时销毁请求并将端口视为已占用，避免误启第二个服务。
    request.on("timeout", () => {
      request.destroy();
      resolve({ available: true, statusCode: 0, body: "" });
    });
    // 仅连接被拒绝视为端口空闲，其他连接错误视为占用。
    request.on("error", (error) => {
      resolve({ available: error.code !== "ECONNREFUSED", statusCode: 0, body: "" });
    });
  });

// 返回延时 Promise；内部执行器只注册计时器，不阻塞事件循环。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parentPid = process.ppid;
// 尚未创建自有服务时，关闭操作只退出当前等待进程。
let close = async () => process.exit(0);

// 收到退出信号时调用当前关闭策略。
const closeOnSignal = () => {
  void close();
};

process.on("SIGINT", closeOnSignal);
process.on("SIGTERM", closeOnSignal);

// 定期用零信号检查父进程是否存在，失败时关闭当前进程。
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

// 创建自有 Vite 服务后，退出前先关闭该服务。
close = async () => {
  await server.close();
  process.exit(0);
};
