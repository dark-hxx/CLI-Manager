import { create } from "zustand";
import type { TranslationKey } from "../lib/i18n";

export type BackgroundOperationStatus = "running" | "succeeded" | "failed";
export type BackgroundOperationKind = "dataSync" | "remoteHistory" | "remoteFiles" | "remoteGit" | "sshHook";

export interface BackgroundOperation {
  id: string;
  kind: BackgroundOperationKind;
  titleKey: TranslationKey;
  detailKey: TranslationKey;
  detailParams?: Record<string, string | number>;
  contextLabel?: string;
  status: BackgroundOperationStatus;
  progress: number | null;
  error: string;
  startedAt: number;
  updatedAt: number;
  retry?: () => void | Promise<void>;
}

type StartOperation = Pick<BackgroundOperation, "id" | "kind" | "titleKey" | "detailKey">
  & Partial<Pick<BackgroundOperation, "detailParams" | "contextLabel" | "progress" | "retry">>;

interface BackgroundOperationStore {
  operations: Record<string, BackgroundOperation>;
  start: (operation: StartOperation) => void;
  succeed: (id: string, detailKey?: TranslationKey) => void;
  fail: (id: string, error: unknown) => void;
  dismiss: (id: string) => void;
  clearFinished: () => void;
}

const MAX_OPERATIONS = 30;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedOperations(operations: Record<string, BackgroundOperation>) {
  const entries = Object.entries(operations).sort(([, left], [, right]) => right.updatedAt - left.updatedAt);
  return Object.fromEntries(entries.slice(0, MAX_OPERATIONS));
}

export const useBackgroundOperationStore = create<BackgroundOperationStore>((set) => ({
  operations: {},
  start: (input) => set((state) => {
    const now = Date.now();
    const previous = state.operations[input.id];
    return {
      operations: boundedOperations({
        ...state.operations,
        [input.id]: {
          ...input,
          detailParams: input.detailParams,
          contextLabel: input.contextLabel,
          status: "running",
          progress: input.progress ?? null,
          error: "",
          startedAt: previous?.status === "running" ? previous.startedAt : now,
          updatedAt: now,
        },
      }),
    };
  }),
  succeed: (id, detailKey = "backgroundOperations.detail.completed") => set((state) => {
    const operation = state.operations[id];
    if (!operation) return state;
    return {
      operations: {
        ...state.operations,
        [id]: { ...operation, status: "succeeded", progress: 100, error: "", detailKey, updatedAt: Date.now() },
      },
    };
  }),
  fail: (id, error) => set((state) => {
    const operation = state.operations[id];
    if (!operation) return state;
    return {
      operations: {
        ...state.operations,
        [id]: { ...operation, status: "failed", error: errorText(error), updatedAt: Date.now() },
      },
    };
  }),
  dismiss: (id) => set((state) => {
    const operations = { ...state.operations };
    delete operations[id];
    return { operations };
  }),
  clearFinished: () => set((state) => ({
    operations: Object.fromEntries(Object.entries(state.operations).filter(([, operation]) => operation.status === "running")),
  })),
}));
