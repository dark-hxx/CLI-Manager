export interface Group {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  group_name: string;
  group_id: string | null;
  sort_order: number;
  cli_tool: string;
  startup_cmd: string;
  env_vars: string;
  created_at: string;
  updated_at: string;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  group_id?: string | null;
  group_name?: string;
  cli_tool?: string;
  startup_cmd?: string;
  env_vars?: string;
}

export interface UpdateProjectInput {
  name?: string;
  path?: string;
  group_id?: string | null;
  group_name?: string;
  sort_order?: number;
  cli_tool?: string;
  startup_cmd?: string;
  env_vars?: string;
}

export interface CreateGroupInput {
  name: string;
  parent_id?: string | null;
}

export type TreeNode =
  | { type: "group"; group: Group; children: TreeNode[] }
  | { type: "project"; project: Project };

export interface TerminalSession {
  id: string;
  projectId?: string;
  title: string;
}
