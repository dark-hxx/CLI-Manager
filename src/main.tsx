import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initLogging, installGlobalCrashHandlers, reportFrontendCrash } from "./shared/platform/logger";

installGlobalCrashHandlers();

// 禁用 WebView 默认右键菜单；组件自定义的 onContextMenu 不受影响
window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

async function bootstrap() {
  const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
  const isDesktopPetWindow = getCurrentWindow().label === "desktop-pet";
  if (isDesktopPetWindow) {
    const { default: DesktopPetApp } = await import("./features/desktop-pet/api/DesktopPetApp");
    root.render(
      <React.StrictMode>
        <DesktopPetApp />
      </React.StrictMode>
    );
    return;
  }

  const [
    { default: App },
    { AppErrorBoundary },
    { AppMantineThemeProvider },
    { QueryClientProvider },
    { queryClient },
  ] = await Promise.all([
    import("./app/App"),
    import("./app/components/AppErrorBoundary"),
    import("./shared/ui/MantineThemeProvider"),
    import("@tanstack/react-query"),
    import("./shared/platform/queryClient"),
    import("@mantine/core/styles.css"),
  ]);
  void initLogging();
  root.render(
    <React.StrictMode>
      <AppErrorBoundary>
        <AppMantineThemeProvider>
          <QueryClientProvider client={queryClient}>
            <App />
          </QueryClientProvider>
        </AppMantineThemeProvider>
      </AppErrorBoundary>
    </React.StrictMode>
  );
}

void bootstrap().catch((error: unknown) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  reportFrontendCrash({
    kind: "bootstrap_failure",
    message: normalized.message,
    stack: normalized.stack,
    url: window.location.href,
  });
  console.error("CLI-Manager bootstrap failed:", normalized);
});
