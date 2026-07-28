interface GitTransportProjectIdentity {
  id: string;
  path: string;
  environment_type: "local" | "wsl" | "ssh";
}

export function createLocalGitTransportContextKey(project: GitTransportProjectIdentity): string {
  const normalized = project.path.trim().replace(/\\/g, "/");
  const withoutTrailingSlash = normalized === "/"
    ? normalized
    : /^[A-Za-z]:\/+$/u.test(normalized)
      ? `${normalized.slice(0, 2)}/`
      : normalized.replace(/\/+$/gu, "");
  const projectPath = /^[A-Za-z]:\//u.test(withoutTrailingSlash)
    ? withoutTrailingSlash.toLowerCase()
    : withoutTrailingSlash;
  return `local:${project.environment_type}:${project.id}:${projectPath}`;
}
