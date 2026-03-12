import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface Props {
  sessionId: string;
  fontSize?: number;
  fontFamily?: string;
}

export function XTermTerminal({ sessionId, fontSize = 14, fontFamily = "Cascadia Code, Consolas, monospace" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      cursorBlink: true,
      cursorStyle: "block",
      fontSize,
      fontFamily,
      scrollback: 1000,
      theme: {
        background: "#1a1b26",
        foreground: "#c0caf5",
        cursor: "#c0caf5",
        selectionBackground: "#364a82",
        black: "#15161e",
        red: "#f7768e",
        green: "#9ece6a",
        yellow: "#e0af68",
        blue: "#7aa2f7",
        magenta: "#bb9af7",
        cyan: "#7dcfff",
        white: "#a9b1d6",
        brightBlack: "#414868",
        brightRed: "#f7768e",
        brightGreen: "#9ece6a",
        brightYellow: "#e0af68",
        brightBlue: "#7aa2f7",
        brightMagenta: "#bb9af7",
        brightCyan: "#7dcfff",
        brightWhite: "#c0caf5",
      },
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(containerRef.current);

    try {
      terminal.loadAddon(new WebglAddon());
    } catch {
      // WebGL not supported, fall back to canvas
    }

    fitAddon.fit();
    terminalRef.current = terminal;

    // Forward keyboard input to PTY
    terminal.onData((data) => {
      invoke("pty_write", { sessionId, data }).catch(console.error);
    });

    // Sync resize to PTY
    terminal.onResize(({ cols, rows }) => {
      invoke("pty_resize", { sessionId, cols, rows }).catch(console.error);
    });

    // Listen for PTY output
    let unlisten: UnlistenFn | null = null;
    listen<string>(`pty-output-${sessionId}`, (event) => {
      terminal.write(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
    });
    resizeObserver.observe(containerRef.current);

    // Initial resize sync
    const dims = fitAddon.proposeDimensions();
    if (dims) {
      invoke("pty_resize", { sessionId, cols: dims.cols, rows: dims.rows }).catch(console.error);
    }

    return () => {
      resizeObserver.disconnect();
      unlisten?.();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [sessionId, fontSize, fontFamily]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full"
      style={{ backgroundColor: "#1a1b26" }}
    />
  );
}
