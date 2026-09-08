export interface CliSessionRebind {
  cliSessionId: string | undefined;
  changed: boolean;
}

export function resolveCliSessionRebind(
  currentCliSessionId: string | undefined,
  incomingCliSessionId: string | undefined | null
): CliSessionRebind {
  const incoming = incomingCliSessionId?.trim();
  if (!incoming || incoming === currentCliSessionId) {
    return { cliSessionId: currentCliSessionId, changed: false };
  }
  return { cliSessionId: incoming, changed: true };
}
