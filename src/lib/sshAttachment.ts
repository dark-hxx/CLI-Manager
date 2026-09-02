const SSH_ATTACHMENT_ROOT_MAX_LENGTH = 4096;

export function normalizeSshAttachmentRoot(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

/** Validate a remote POSIX parent path without touching the remote filesystem. */
export function isValidSshAttachmentRoot(value: string | null | undefined): boolean {
  if (typeof value === "string" && /[\u0000-\u001F\u007F]/u.test(value)) return false;
  const path = normalizeSshAttachmentRoot(value);
  if (!path) return true;
  if (path.length > SSH_ATTACHMENT_ROOT_MAX_LENGTH) return false;
  if (/[\u0000-\u001F\u007F\\$`]/u.test(path)) return false;
  if (!(path.startsWith("/") || path === "~" || path.startsWith("~/"))) return false;
  return !path.split("/").some((segment) => segment === "..");
}
