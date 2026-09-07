export type ProjectFetchReason = "startup" | "interactive";

export interface ProjectFetchPolicy {
  includePathHealth: boolean;
  refreshProviderBadges: boolean;
}

export function resolveProjectFetchPolicy(reason: ProjectFetchReason): ProjectFetchPolicy {
  if (reason === "startup") {
    return {
      includePathHealth: false,
      refreshProviderBadges: false,
    };
  }

  return {
    includePathHealth: true,
    refreshProviderBadges: true,
  };
}

export function shouldSidebarBootstrapProjects(storeLoaded: boolean): boolean {
  return !storeLoaded;
}
