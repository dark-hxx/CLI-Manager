import { create } from "zustand";
import {
  cancelRemoteHandoff,
  fetchRemoteHandoffPlatforms,
  fetchRemoteHandoffStatus,
  startRemoteHandoff,
  type CcConnectHandoffStartRequest,
  type CcConnectHandoffPlatformTarget,
  type CcConnectHandoffStatus,
} from "../lib/remoteHandoff";

const EMPTY_STATUS: CcConnectHandoffStatus = {
  active: false,
  running: false,
  info: null,
  warning: null,
};

interface RemoteHandoffStore {
  status: CcConnectHandoffStatus;
  platforms: CcConnectHandoffPlatformTarget[];
  loaded: boolean;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  refresh: () => Promise<CcConnectHandoffStatus>;
  refreshPlatforms: () => Promise<CcConnectHandoffPlatformTarget[]>;
  start: (request: CcConnectHandoffStartRequest) => Promise<CcConnectHandoffStatus>;
  cancel: () => Promise<CcConnectHandoffStatus>;
}

export const useRemoteHandoffStore = create<RemoteHandoffStore>((set, get) => ({
  status: EMPTY_STATUS,
  platforms: [],
  loaded: false,
  busy: false,
  setBusy: (busy) => set({ busy }),

  refresh: async () => {
    const status = await fetchRemoteHandoffStatus();
    set({ status, loaded: true });
    await get().refreshPlatforms().catch(() => undefined);
    return status;
  },

  refreshPlatforms: async () => {
    const platforms = await fetchRemoteHandoffPlatforms();
    set({ platforms });
    return platforms;
  },

  start: async (request) => {
    const status = await startRemoteHandoff(request);
    set({ status, loaded: true });
    await get().refreshPlatforms().catch(() => undefined);
    return status;
  },

  cancel: async () => {
    const status = await cancelRemoteHandoff();
    set({ status, loaded: true });
    await get().refreshPlatforms().catch(() => undefined);
    return status;
  },
}));
