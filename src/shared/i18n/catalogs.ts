import { zh as agentIntegrationsZh } from "./messages/agent-integrations.zh-CN";
import { en as agentIntegrationsEn } from "./messages/agent-integrations.en-US";
import { zh as analyticsZh } from "./messages/analytics.zh-CN";
import { en as analyticsEn } from "./messages/analytics.en-US";
import { zh as commandToolsZh } from "./messages/command-tools.zh-CN";
import { en as commandToolsEn } from "./messages/command-tools.en-US";
import { zh as commonZh } from "./messages/common.zh-CN";
import { en as commonEn } from "./messages/common.en-US";
import { zh as desktopPetZh } from "./messages/desktop-pet.zh-CN";
import { en as desktopPetEn } from "./messages/desktop-pet.en-US";
import { zh as filesZh } from "./messages/files.zh-CN";
import { en as filesEn } from "./messages/files.en-US";
import { zh as gitZh } from "./messages/git.zh-CN";
import { en as gitEn } from "./messages/git.en-US";
import { zh as historyZh } from "./messages/history.zh-CN";
import { en as historyEn } from "./messages/history.en-US";
import { zh as projectsZh } from "./messages/projects.zh-CN";
import { en as projectsEn } from "./messages/projects.en-US";
import { zh as providersZh } from "./messages/providers.zh-CN";
import { en as providersEn } from "./messages/providers.en-US";
import { zh as settingsZh } from "./messages/settings.zh-CN";
import { en as settingsEn } from "./messages/settings.en-US";
import { zh as sshZh } from "./messages/ssh.zh-CN";
import { en as sshEn } from "./messages/ssh.en-US";
import { zh as syncZh } from "./messages/sync.zh-CN";
import { en as syncEn } from "./messages/sync.en-US";
import { zh as terminalZh } from "./messages/terminal.zh-CN";
import { en as terminalEn } from "./messages/terminal.en-US";

export const zh = {
  ...agentIntegrationsZh,
  ...analyticsZh,
  ...commandToolsZh,
  ...commonZh,
  ...desktopPetZh,
  ...filesZh,
  ...gitZh,
  ...historyZh,
  ...projectsZh,
  ...providersZh,
  ...settingsZh,
  ...sshZh,
  ...syncZh,
  ...terminalZh,
} as const;

export const en: Record<keyof typeof zh, string> = {
  ...agentIntegrationsEn,
  ...analyticsEn,
  ...commandToolsEn,
  ...commonEn,
  ...desktopPetEn,
  ...filesEn,
  ...gitEn,
  ...historyEn,
  ...projectsEn,
  ...providersEn,
  ...settingsEn,
  ...sshEn,
  ...syncEn,
  ...terminalEn,
};
