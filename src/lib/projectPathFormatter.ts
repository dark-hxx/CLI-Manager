import type { Project, ProjectFileEntry } from "./types";

type ProjectPathContext = Pick<Project, "path" | "remote_path" | "environment_type">;

function normalizeRelativePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function projectRootPath(project: ProjectPathContext): string {
  return (project.environment_type === "ssh" ? project.remote_path : project.path).trim();
}

export function formatProjectAbsolutePath(project: ProjectPathContext, relativePath: string): string {
  const root = projectRootPath(project);
  const relative = normalizeRelativePath(relativePath);
  if (!relative) return root;

  const separator = root.includes("\\") ? "\\" : "/";
  const trimmedRoot = root.replace(/[\\/]+$/g, "");
  const normalizedRelative = relative.replace(/\//g, separator);
  if (!trimmedRoot) return `${separator}${normalizedRelative}`;
  return `${trimmedRoot}${separator}${normalizedRelative}`;
}

export function formatProjectRelativePath(relativePath: string): string {
  return normalizeRelativePath(relativePath) || ".";
}

export type { ProjectPathContext };

export type CopyPathKind = ProjectFileEntry["kind"];
