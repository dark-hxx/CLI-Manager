export type NativeProviderAppType = "claude" | "codex" | "grokbuild";
export type NativeProviderEnvironmentKind = "local" | "wsl";

export const NATIVE_PROVIDER_APP_TYPES: readonly NativeProviderAppType[] = [
  "claude",
  "codex",
  "grokbuild",
];

export interface NativeProviderCard {
  id: string;
  appType: string;
  name: string;
  websiteUrl: string | null;
  category: string | null;
  notes: string | null;
  icon: string | null;
  iconColor: string | null;
  sortIndex: number;
  createdAt: number;
  isCurrent: boolean;
  enabled: boolean;
  keyCount: number;
  activeKeyLabel: string | null;
  baseUrl: string | null;
  model: string | null;
  apiFormat: string | null;
  settingsValid: boolean;
  commonConfigEnabled: boolean;
}

export interface NativeProviderKeySummary {
  id: string;
  providerId: string;
  appType: string;
  label: string;
  maskedApiKey: string;
  tags: string[];
  notes: string;
  enabled: boolean;
  sortIndex: number;
  isActive: boolean;
  createdAt: number;
  updatedAt: number;
}

export type NativeClaudeApiFormat =
  | "anthropic"
  | "openai_chat"
  | "openai_responses"
  | "gemini_native";

export type NativeClaudeAuthField = "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY";

export interface NativeProviderClaudeConfig {
  apiFormat: NativeClaudeApiFormat;
  apiKeyField: NativeClaudeAuthField;
  isFullUrl: boolean;
  model: string;
  defaultHaikuModel: string;
  defaultHaikuModelName: string;
  defaultSonnetModel: string;
  defaultSonnetModelName: string;
  defaultOpusModel: string;
  defaultOpusModelName: string;
  defaultFableModel: string;
  defaultFableModelName: string;
  subagentModel: string;
}

export interface NativeProviderDetail {
  card: NativeProviderCard;
  settingsConfig: string;
  effectiveSettingsConfig: string;
  settingsHasSecret: boolean;
  claudeConfig?: NativeProviderClaudeConfig | null;
  documents: NativeProviderDocument[];
  keys: NativeProviderKeySummary[];
}

export interface NativeProviderDocument {
  kind: string;
  format: "json" | "toml";
  value: string;
  hasSecret: boolean;
  valid: boolean;
}

export interface NativeProviderDocumentUpdateInput {
  appType: NativeProviderAppType;
  providerId: string;
  kind: string;
  value: string;
}

export interface NativeProviderCommonConfig {
  appType: string;
  value: string;
  format: string;
}

export interface NativeProviderCreateInput {
  appType: NativeProviderAppType;
  name: string;
  settingsConfig?: string;
  baseUrl?: string;
  model?: string;
  apiFormat?: string;
  websiteUrl?: string;
  category?: string;
  notes?: string;
  icon?: string;
  iconColor?: string;
  commonConfigEnabled?: boolean;
  claudeConfig?: NativeProviderClaudeConfig;
}

export interface NativeProviderUpdateInput extends NativeProviderCreateInput {
  providerId: string;
}

export interface NativeProviderKeyCreateInput {
  providerId: string;
  appType: NativeProviderAppType;
  label: string;
  apiKey: string;
  tags?: string[];
  notes?: string;
  enabled?: boolean;
  activate?: boolean;
}

export interface NativeProviderKeyUpdateInput {
  id: string;
  providerId: string;
  appType: NativeProviderAppType;
  label?: string;
  apiKey?: string;
  tags?: string[];
  notes?: string;
  enabled?: boolean;
}

export interface NativeProviderHomeIdentity {
  environmentKind: NativeProviderEnvironmentKind;
  environmentId: string;
  identity: string;
}

export interface NativeProviderHomeTargets {
  homePath: string;
  claudeConfigDir: string;
  claudeHistoryRoot: string;
  codexConfigDir: string;
  codexHistoryRoot: string;
  grokConfigDir: string;
  grokHistoryRoot: string;
}

export interface NativeProviderHomeState {
  identity: NativeProviderHomeIdentity;
  mode: "auto" | "manual";
  homePath: string;
  source: "auto" | "manual";
  targets: NativeProviderHomeTargets;
}

export interface NativeProviderHomeInput {
  environmentKind: NativeProviderEnvironmentKind;
  environmentId?: string | null;
  mode: "auto" | "manual";
  homePath?: string | null;
}

export interface NativeProviderGlobalTargetPreview {
  target: string;
  path: string;
  exists: boolean;
  liveFingerprint: string;
  desiredFingerprint: string;
  changed: boolean;
  action: "create" | "update" | "unchanged";
  ownedFields: string[];
}

export interface NativeProviderGlobalPreview {
  appType: NativeProviderAppType;
  providerId: string;
  providerName: string;
  home: NativeProviderHomeState;
  fingerprint: string;
  targets: NativeProviderGlobalTargetPreview[];
}

export interface NativeProviderGlobalApplyResult {
  appType: NativeProviderAppType;
  providerId: string;
  homeIdentity: NativeProviderHomeIdentity;
  journalId: string;
  state: string;
  changedTargets: string[];
  verifiedFingerprints: Record<string, string>;
}

export interface NativeProviderGlobalCurrent {
  appType: NativeProviderAppType;
  home: NativeProviderHomeState;
  providerId: string | null;
  providerName: string | null;
  activeKeyPresent: boolean;
  state: "not_set" | "key_missing" | "applied" | "drifted" | "unavailable" | "recovery_pending" | string;
  pendingRecovery: boolean;
  targets: NativeProviderGlobalTargetPreview[];
}

export interface NativeProviderRoutingService {
  schemaVersion: number;
  serviceEnabled: boolean;
  listenAddress: string;
  preferredPort: number;
  actualPort: number | null;
  showLocalQuickControl: boolean;
  showFailoverQuickControl: boolean;
  usageLoggingEnabled: boolean;
}

export interface NativeProviderRoutingTakeover {
  appType: string;
  homeIdentity: NativeProviderHomeIdentity;
  endpointMode: string;
  advertisedHost: string;
  appliedPort: number;
}

export interface NativeProviderRoutingDaemon {
  status: string;
  connected: boolean;
  capabilitySupported: boolean;
  error: { code: string; hint: string } | null;
  listenerAddresses: string[];
  preferredPort: number | null;
  actualPort: number | null;
}

export interface NativeProviderRoutingState {
  persisted: {
    service: NativeProviderRoutingService;
    takeovers: NativeProviderRoutingTakeover[];
  };
  daemon: NativeProviderRoutingDaemon;
}

export interface NativeProviderRectifierConfig {
  schemaVersion: number;
  enabled: boolean;
  requestThinkingSignature: boolean;
  requestThinkingBudget: boolean;
  requestMediaFallback: boolean;
  requestMediaHeuristic: boolean;
}

export interface NativeProviderOptimizerConfig {
  schemaVersion: number;
  enabled: boolean;
  thinkingOptimizer: boolean;
  cacheInjection: boolean;
}

export interface NativeProviderEnvironmentInspectInput {
  appType?: NativeProviderAppType | null;
  homeIdentity: {
    environmentKind: NativeProviderEnvironmentKind;
    environmentId?: string | null;
  };
  homeInput?: NativeProviderHomeInput | null;
  configuredRoots?: {
    claude?: string | null;
    codex?: string | null;
    grok?: string | null;
  };
  historyRoots?: {
    claude?: string | null;
    codex?: string | null;
    grok?: string | null;
  };
}

export interface NativeProviderFailoverConfig {
  schemaVersion: number;
  autoFailoverEnabled: boolean;
  maxRetries: number;
  streamingFirstByteTimeout: number;
  streamingIdleTimeout: number;
  nonStreamingTimeout: number;
  circuitFailureThreshold: number;
  circuitSuccessThreshold: number;
  circuitTimeoutSeconds: number;
  circuitErrorRateThreshold: number;
  circuitMinRequests: number;
}

export interface NativeProviderFailoverProvider {
  id: string;
  name: string;
  sortIndex: number;
  isCurrent: boolean;
  enabled: boolean;
  ready: boolean;
  inFailoverQueue: boolean;
  keyCount: number;
  activeKeyPresent: boolean;
}

export interface NativeProviderFailoverCircuit {
  providerId: string;
  status: string;
  consecutiveFailures: number;
  successfulProbes: number;
}

export interface NativeProviderFailoverState {
  appType: NativeProviderAppType;
  config: NativeProviderFailoverConfig;
  providers: NativeProviderFailoverProvider[];
  circuit: NativeProviderFailoverCircuit;
  circuits: NativeProviderFailoverCircuit[];
}

export interface NativeProviderCliStatus {
  name: string;
  executable: string | null;
  version: string | null;
  available: boolean;
}

export interface NativeProviderTargetStatus {
  name: string;
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  syntax: string;
  fingerprint: string;
}

export interface NativeProviderEnvironmentConflict {
  variable: string;
  present: boolean;
  matchesHome: boolean;
  fingerprint: string | null;
}

export interface NativeProviderEnvironmentReport {
  home: NativeProviderHomeState;
  cli: NativeProviderCliStatus[];
  targets: NativeProviderTargetStatus[];
  currentProvider: {
    providerId: string | null;
    providerName: string | null;
    present: boolean;
    activeKeyPresent: boolean;
  };
  conflicts: NativeProviderEnvironmentConflict[];
  alignment: {
    source: string;
    claudeHistoryRoot: string;
    codexHistoryRoot: string;
    grokHistoryRoot: string;
    claudeHookRoot: string;
    codexHookRoot: string;
    grokHookRoot: string;
    explicitRoots: string[];
    automaticRootsAligned: boolean;
  };
  pendingRecovery: boolean;
}

export interface NativeProviderImportKeyPreview {
  label: string;
  tags: string[];
  notes: string;
  enabled: boolean;
  sortIndex: number;
  isActive: boolean;
  hasSecret: boolean;
  maskedApiKey: string | null;
  reason: string | null;
}

export interface NativeProviderImportProviderPreview {
  sourceId: string;
  appType: string;
  name: string;
  websiteUrl: string | null;
  category: string | null;
  notes: string | null;
  sortIndex: number;
  isCurrent: boolean;
  settingsValid: boolean;
  settingsPreview: string;
  settingsHasSecret: boolean;
  baseUrl: string | null;
  model: string | null;
  apiFormat: string | null;
  keys: NativeProviderImportKeyPreview[];
  action: "create" | "update" | "unchanged" | "skip";
  nativeProviderId: string | null;
  reason: string | null;
}

export interface NativeProviderImportCommonPreview {
  appType: string;
  format: string;
  hasSecret: boolean;
  fingerprint: string;
  sanitizedValue: string;
}

export interface NativeProviderImportScopePreview {
  scopeKind: string;
  scopeId: string;
  appType: string;
  sourceProviderId: string;
  nativeProviderId: string | null;
  action: "migrate" | "repair";
  reason: string | null;
}

export interface NativeProviderImportPreview {
  sourceKind: string;
  sourceIdentity: string;
  sourcePath: string;
  sourceFingerprint: string;
  schema: {
    providersTable: boolean;
    settingsTable: boolean;
    multiKeyTable: boolean;
    providerColumns: string[];
  };
  providers: NativeProviderImportProviderPreview[];
  commonConfigs: NativeProviderImportCommonPreview[];
  scopes: NativeProviderImportScopePreview[];
  warnings: string[];
}

export interface NativeProviderImportResult {
  sourceKind: string;
  sourceIdentity: string;
  sourceFingerprint: string;
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  keysImported: number;
  currentCandidates: number;
  migratedScopes: number;
  repairIssues: number;
  warnings: string[];
}

export interface NativeProviderImportIssue {
  id: string;
  scopeKind: string;
  scopeId: string;
  appType: string;
  sourceProviderId: string;
  reason: string;
  createdAt: number;
}

export function providerErrorCode(error: unknown): string {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
        ? error.message
        : "provider_unknown_error";

  return message.split(":", 1)[0] || "provider_unknown_error";
}
