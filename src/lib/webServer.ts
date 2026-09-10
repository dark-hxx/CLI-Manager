import { invoke } from "@tauri-apps/api/core";

export interface WebServerStatus {
  trustedNetwork: boolean;
  localDeviceUrl: string;
  interfaces: Array<[string, string]>;
  configured: boolean;
  running: boolean;
  stopping: boolean;
  autoStart: boolean;
  bind: string;
  port: number;
  url: string;
  allowedOrigin: string | null;
  networkExposed: boolean;
  lastError: string | null;
}

export interface WebServerConfigInput {
  trustedNetwork: boolean;
  autoStart: boolean;
  bind: string;
  port: number;
  adminUsername: string;
  adminPassword?: string;
  allowedOrigin?: string;
}

export const webServerApi = {
  getStatus: () => invoke<WebServerStatus>("web_server_get_status"),
  saveConfig: (request: WebServerConfigInput) => invoke<WebServerStatus>("web_server_save_config", { request }),
  start: () => invoke<WebServerStatus>("web_server_start"),
  stop: () => invoke<WebServerStatus>("web_server_stop"),
  restart: () => invoke<WebServerStatus>("web_server_restart"),
};
