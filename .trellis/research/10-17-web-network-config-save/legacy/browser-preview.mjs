// Controlled production-bundle fixture: no native app, real credentials or CLI operations.
import http from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../apps/web/dist");
const workspace = {
  groups: [
    { id: "development", name: "开发项目", parentId: null, sortOrder: 1 },
    { id: "frontend", name: "前端", parentId: "development", sortOrder: 1 },
    { id: "python", name: "Python", parentId: null, sortOrder: 4 },
  ],
  projects: [
    { id: "local", name: "CLI-Manager", source: "codex", cwd: "D:\\development\\CLI-Manager", groupId: "development", sortOrder: 2, environmentType: "local" },
    { id: "other", name: "CLI-Manager", source: "claude", cwd: "D:\\projects\\CLI-Manager", groupId: "frontend", sortOrder: 1, environmentType: "local" },
    { id: "smart-local", name: "smart-home-assistant", source: "claude", cwd: "D:\\projects\\smart-home-assistant", groupId: "development", sortOrder: 3, environmentType: "local" },
    { id: "smart-wsl", name: "smart-home-assistant", source: "codex", cwd: "/home/dev/smart-home-assistant", groupId: "python", sortOrder: 1, environmentType: "wsl" },
    { id: "oracle", name: "oracle-1", source: null, cwd: "/home/oracle", groupId: null, sortOrder: 2, environmentType: "ssh" },
  ], worktrees: [],
  terminals: [{ sessionId: "session", projectId: "local", worktreeId: null, title: "CLI-Manager" }], updatedAt: 1,
};
const device = { id: "fixture", name: "CLI-Manager 桌面端", status: "online", capabilities: [], platform: "Windows", appVersion: "1.4.4" };
const json = (res, value) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/auth/status") return json(res, { authenticated: true, user: { id: "fixture-user", username: "fixture" } });
  if (url.pathname === "/api/devices") return json(res, { devices: [device] });
  if (url.pathname === "/api/history") return json(res, { workspace, sessions: [] });
  if (url.pathname.startsWith("/api/")) { res.writeHead(405); res.end(); return; }
  const route = url.pathname === "/tap/" ? "/tap/index.html" : url.pathname;
  const file = path.resolve(dist, `.${route}`);
  if (!file.startsWith(dist + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const body = await readFile(file);
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".png": "image/png" };
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream" }); res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
server.on("upgrade", (req, socket) => {
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const payload = Buffer.from(JSON.stringify({ type: "ready", latestSequence: 0 }));
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  socket.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => console.log(`http://127.0.0.1:${server.address().port}/tap/`));
