import type { WebDeviceStatus } from "./webDevice";

type StatusRequest = () => Promise<WebDeviceStatus>;
type StatusListener = (status: WebDeviceStatus) => void;

// 共享 IPC 快照而非页面定时器；只保留最近状态，旧请求回执不能覆盖已接收的较新请求。
export function createWebDeviceStatusSource() {
  let snapshot: WebDeviceStatus | null = null;
  let snapshotKey: string | undefined;
  let requestSequence = 0;
  let acceptedSequence = 0;
  let pendingRead: Promise<WebDeviceStatus> | null = null;
  const listeners = new Set<StatusListener>();

  async function request(load: StatusRequest): Promise<WebDeviceStatus> {
    const sequence = ++requestSequence;
    const next = await load();
    if (sequence > acceptedSequence) {
      acceptedSequence = sequence;
      const key = JSON.stringify(next);
      if (key !== snapshotKey) {
        snapshot = next;
        snapshotKey = key;
        for (const listener of listeners) listener(next);
      }
    }
    // 保存调用方需要本次原始 profile；共享订阅只收到通过顺序校验的状态。
    return next;
  }

  // 全局 bridge、页面初次加载和事件刷新合并查询；迟到查询向调用方返回最新已知快照。
  function refresh(load: StatusRequest): Promise<WebDeviceStatus> {
    if (!pendingRead) {
      pendingRead = request(load)
        .then((next) => snapshot ?? next)
        .finally(() => { pendingRead = null; });
    }
    return pendingRead;
  }

  return {
    request,
    refresh,
    // 重开页面先回放最新快照；取消订阅只释放 UI 监听，不停止设备连接。
    subscribe(listener: StatusListener) {
      listeners.add(listener);
      if (snapshot) listener(snapshot);
      return () => { listeners.delete(listener); };
    },
  };
}

export const webDeviceStatusSource = createWebDeviceStatusSource();
