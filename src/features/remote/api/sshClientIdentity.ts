const SSH_CLIENT_INSTANCE_ID_KEY = "cli-manager.sshClientInstanceId";
let fallbackSshClientInstanceId = "";

export function getSshClientInstanceId(): string {
  try {
    const current = localStorage.getItem(SSH_CLIENT_INSTANCE_ID_KEY)?.trim();
    if (current && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(current)) {
      return current;
    }
    const created = crypto.randomUUID();
    localStorage.setItem(SSH_CLIENT_INSTANCE_ID_KEY, created);
    return created;
  } catch {
    fallbackSshClientInstanceId ||= crypto.randomUUID();
    return fallbackSshClientInstanceId;
  }
}
