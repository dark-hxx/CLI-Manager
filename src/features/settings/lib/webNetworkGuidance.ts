import type { TranslationKey } from "../../../shared/i18n/index";

type BindScope = "loopback" | "network" | "all" | "invalid";

// 仅供界面提示，不代替 Rust 的本机网卡、地址和 Origin 校验，也不自动授予信任。
export function webBindScope(value: string): BindScope {
  const ip = value.trim();
  if (/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(ip)) {
    const parts = ip.split(".").map(Number);
    if (parts.some((part) => part > 255)) return "invalid";
    if (parts[0] === 127) return "loopback";
    return ip === "0.0.0.0" ? "all" : "network";
  }
  if (!ip.includes(":") || !/^[\da-f:.]+$/i.test(ip)) return "invalid";
  try {
    const host = new URL(`http://[${ip}]`).hostname;
    return host === "[::1]" ? "loopback" : host === "[::]" ? "all" : "network";
  } catch { return "invalid"; }
}

export function webServerNetworkRequirement(bind: string, origin: string, trusted: boolean): TranslationKey | null {
  const scope = webBindScope(bind);
  if (scope === "all" && !origin.trim()) return "settings.webServer.error.originRequired";
  if ((scope === "network" || scope === "all") && !trusted && !/^https:\/\//i.test(origin.trim())) {
    return "settings.webServer.error.trustedNetworkRequired";
  }
  return null;
}

// 设备地址和浏览器来源分别检查；HTTPS 浏览器来源不能替代设备 WS 通道的显式信任。
export function webDeviceNeedsNetworkTrust(serverUrl: string, publicUrl: string, trusted: boolean): boolean {
  if (trusted) return false;
  return [serverUrl, publicUrl].some((value) => {
    try {
      const url = new URL(value.trim());
      if (url.protocol !== "http:" && url.protocol !== "ws:") return false;
      const host = url.hostname.replace(/^\[|\]$/g, "");
      return host.toLowerCase() !== "localhost" && webBindScope(host) !== "loopback";
    } catch { return false; }
  });
}

// 保留现有 IPC 错误字符串兼容性；未知错误仍显示原始诊断。
export function webNetworkErrorKey(error: unknown): TranslationKey | null {
  switch (String(error)) {
    case "web_server_still_stopping": return "settings.webServer.error.stopping";
    case "Web server admin username must contain 1 to 128 bytes":
      return "settings.webServer.error.adminUsername";
    case "Web server admin password cannot exceed 1024 bytes":
      return "settings.webServer.error.adminPassword";
    case "Enable trusted network HTTP explicitly, or configure an HTTPS browser origin":
      return "settings.webServer.error.trustedNetworkRequired";
    case "Allowed Origin is required when listening on all network interfaces":
      return "settings.webServer.error.originRequired";
    case "Allowed Origin must be a valid HTTP or HTTPS origin":
    case "Allowed Origin must contain only an HTTP or HTTPS scheme, host, and optional port":
    case "Allowed Origin is not a valid network origin":
      return "settings.webServer.error.invalidOrigin";
    case "remote web device server must use TLS":
    case "public access URL requires HTTPS or explicit trusted network mode":
      return "settings.webDevice.error.trustedNetworkRequired";
    default: return null;
  }
}
