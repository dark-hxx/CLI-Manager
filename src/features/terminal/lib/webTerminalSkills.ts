import { invoke } from "@tauri-apps/api/core";
import { inferWslDistroName, resolveWslCapabilityLocation, type AgentCapabilitySnapshot } from "../../agents/api/agentCapabilities";
import { getProviderSwitchAppType } from "../../providers/api/providerSwitching";
import type { Project, TerminalSession } from "../../../shared/types/index";

type SkillContext = { project: Project; rootPath: string; session: TerminalSession };

function requestFor({ project, rootPath, session }: SkillContext) {
  const source = session.cliTool ?? getProviderSwitchAppType(project) ?? "";
  const environment = session.environmentType === "wsl" || project.environment_type === "wsl"
    || session.shell === "wsl" || inferWslDistroName(session.cwd, rootPath) ? "wsl" : "local";
  const configKey = source === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const configRoot = session.envVars?.[configKey]?.trim() || project.cli_config_root?.trim() || null;
  const wsl = environment === "wsl" ? resolveWslCapabilityLocation({ hookDistroName: session.wslDistroName,
    sessionCwd: session.cwd, projectPath: rootPath, configRoot }) : null;
  return { terminalSessionId: session.id, cliSessionId: session.cliSessionId, agent: source, environment,
    cwd: wsl?.cwd ?? rootPath, configRoot, launchArgs: project.cli_args ?? "", runtimeEvidence: [],
    wslDistroName: wsl?.distroName ?? null };
}

/** Reuse bounded, read-only Agent discovery, with host-owned PTY identity and context. */
export async function executeTerminalSkills(resolveContext: () => Promise<SkillContext>) {
  const context = await resolveContext();
  const request = requestFor(context);
  if (!["claude", "codex"].includes(request.agent)) return { available: false, reason: "unsupported", skills: [] };
  if (!request.cliSessionId) return { available: false, reason: "unbound", skills: [] };
  const snapshot = await invoke<AgentCapabilitySnapshot>("agent_capabilities_inspect", { request });
  const current = requestFor(await resolveContext());
  if (JSON.stringify(current) !== JSON.stringify(request) || snapshot.terminalSessionId !== request.terminalSessionId
    || snapshot.cliSessionId !== request.cliSessionId || snapshot.agent !== request.agent || snapshot.environment !== request.environment)
    throw new Error("skill_context_changed");
  if (snapshot.bridgeStatus !== "ready") return { available: false, reason: "unsupported", skills: [] };
  // Export only invocation metadata. No config bodies, absolute paths, MCP data or Skill contents.
  const skills = snapshot.skills.filter((skill) => skill.state === "available"
    && skill.name.length <= 128 && /^[a-z\d][a-z\d:_-]*$/i.test(skill.name)).slice(0, 500)
    .map((skill) => ({ name: skill.name, state: skill.state, description: skill.description?.slice(0, 512) ?? "" }));
  return { available: true, source: request.agent, skills };
}
