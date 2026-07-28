import { useRef, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "../../ui/dialog";
import { DEFAULT_DIFF_ROOT_STYLE, TERMINAL_DIFF_ROOT_STYLE } from "./theme";

interface GitDiffDialogFrameProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  useTerminalTheme?: boolean;
  children: ReactNode;
}

export function GitDiffDialogFrame({
  open,
  onClose,
  ariaLabel,
  useTerminalTheme = false,
  children,
}: GitDiffDialogFrameProps) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        ref={contentRef}
        showCloseButton={false}
        aria-describedby={undefined}
        className="h-[85vh] w-[calc(100vw-1rem)] max-w-6xl overflow-hidden rounded-lg border p-0 shadow-2xl sm:w-[calc(100vw-2rem)]"
        overlayClassName="z-[100] bg-black/60"
        style={{
          ...(useTerminalTheme ? TERMINAL_DIFF_ROOT_STYLE : DEFAULT_DIFF_ROOT_STYLE),
          zIndex: 101,
        }}
        onOpenAutoFocus={(event) => {
          previousFocusRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
          event.preventDefault();
          const firstControl = contentRef.current?.querySelector<HTMLElement>(
            "[data-git-diff-toolbar] button:not(:disabled), [data-git-diff-header] button:not(:disabled)",
          );
          (firstControl ?? contentRef.current)?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
          previousFocusRef.current = null;
        }}
        onEscapeKeyDown={(event) => {
          if (event.isComposing) event.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">{ariaLabel}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  );
}
