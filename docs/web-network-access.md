# Web 网络访问（1.3.9）

监听地址、设备连接地址、浏览器访问地址各自独立。域名通过系统 DNS 解析；监听仍选择本机实际 IP，不能把公网域名填写成监听网卡。当前支持域名根路径，不支持 `/cli-manager/` 子路径挂载。

## 局域网 / NetBird / Tailscale

1. Web 服务选择本机网卡 IP（例如 `100.95.251.17`）、端口 `9090`。
2. 浏览器访问地址填 `http://100.95.251.17:9090`，也可填写解析到该网卡的内部域名。
3. 明确开启“允许受信任内网 HTTP 访问”。保存、启动服务。
4. 同机桌面设备连接使用设置页显示的本机设备地址，例如 `ws://127.0.0.1:9090/ws/device`。具体非回环网卡监听会同时提供 IPv4 回环入口。
5. 其他电脑加入可互通的网络后访问第 2 步地址并登录，无需扫码。

只有设备连接本身跨机器使用 HTTP/WS 时，才需要另外打开设备设置中的“信任此设备连接的网络”。配对、登录及精确浏览器来源校验仍然有效。HTTP 自身不加密；VPN 的加密由组网软件提供，普通局域网不自动视为可信。防火墙应限制服务的访问范围。

## Nginx HTTPS 域名

Web 服务可监听 `127.0.0.1:9090`，浏览器访问地址填 `https://cli.example.com`。保留 HTTPS 配置时使用 Secure Cookie；反向代理到本机的 HTTP 不要求服务内置证书。服务按配置的公开来源判断浏览器访问，忽略未经信任的转发协议头。

```nginx
server {
    listen 443 ssl;
    server_name cli.example.com;
    ssl_certificate /etc/nginx/certs/cli.example.com.fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/cli.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:9090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

域名 A/AAAA 记录应指向实际代理入口；穿透服务需要支持 WebSocket。二维码使用设备设置中独立的“浏览器访问地址”，不要使用 `127.0.0.1`。本机设备连接仍走本地 WS，不因为公开域名改动而把凭据发送到其他主机。

## 独立服务

- `CLI_MANAGER_WEB_BIND`：本机监听 IP:端口。
- `CLI_MANAGER_WEB_ALLOWED_ORIGIN`：精确浏览器来源，支持 IP 或域名。
- `CLI_MANAGER_WEB_TRUSTED_NETWORK=true`：明确允许受信任网络 HTTP。
- `CLI_MANAGER_ADMIN_PASSWORD`：管理员密码，不能省略。

HTTPS 来源启用 Secure Cookie；非回环 HTTP 必须明确选择受信任模式。不接受带用户密码、查询参数、片段或子路径的来源地址。

## 验证与根因

- 设备掉线：具体网卡监听缺少回环入口，导致同机 WS 10061；第二监听与主监听统一初始化和回收。
- HTTP 菜单无响应：`crypto.randomUUID()` 在不安全上下文不可用且错误被吞掉；使用 `getRandomValues` 生成 UUID 并提供错误反馈。
- 快照被拒绝：2026-09-10 主机日志确认数据库 code 5 写锁冲突，非快照格式错误；快照写事务需提前取得写锁。
- GitNexus 不可用时，按服务契约、源码和 Git diff 复核。此次影响认证来源校验、服务生命周期、设备 URL 配置和菜单操作链，按根因修复验证。

实际 NetBird/Tailscale 跨设备和公网 Nginx 证书部署需在对应网络验证；自动化测试不能证明外部路由、防火墙与 DNS 配置正确。

本轮验证：服务端 53 项单测与 4 项重连测试；桌面 Rust Web 相关 49 项通过、1 项依赖外部 CLI 的测试跳过；Web 构建与桌面 TypeScript 检查通过。Chrome 隔离页面以模拟操作验证菜单重命名、克隆、启动、文件/历史入口、取消删除和错误反馈，不对真实项目执行删除。普通 HTTP 缺失 randomUUID 的回归和菜单执行单测通过。后台设备协议升级到 7，安装后需完整退出旧应用再启动。
