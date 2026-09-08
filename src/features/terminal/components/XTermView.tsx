import type { useXTermController } from "../hooks/useXTermController";
import { type CSSProperties } from "react";
import { hexToRgba } from "../../../shared/lib/terminalColor";
import { Portal } from "../../../shared/ui/Portal";
import { FontSizeControl } from "../../../shared/ui/FontSizeControl";
import { ArrowDown, Eye, EyeOff } from "../../../shared/ui/icons";
import { TerminalMarkdownPreview } from "./TerminalMarkdownPreview";
import {
  TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN,
} from "../../../shared/preferences/settingsStore";

export function XTermView({
  wrapperRef,
  wrapperStyle,
  showLocalBackgroundImage,
  background,
  showWorkspaceBackground,
  markdownPreviewButtonVisible,
  markdownPreviewOpen,
  markdownPreviewCanOpen,
  setMarkdownPreviewOpen,
  terminalSearchButtonStyle,
  markdownPreviewRightOffset,
  t,
  searchOpen,
  terminalSearchShellStyle,
  searchInputRef,
  searchTerm,
  handleSearchTermChange,
  runTerminalSearch,
  closeTerminalSearch,
  terminalSearchInputStyle,
  searchResultLabel,
  markdownPreviewPanelPercent,
  handleTerminalFontSizeWheel,
  containerRef,
  terminalContainerStyle,
  isScrolledAwayFromBottom,
  fontSizeControlVisible,
  handleScrollToBottom,
  terminalFontSizeControlStyle,
  fontSize,
  showFontSizeControl,
  updateSettings,
  handleMarkdownPreviewResizeStart,
  sessionId,
  terminalInputSuggestionsEnabled,
  isActive,
  isVisible,
  suggestionGhost,
  searchForeground,
  effectiveFontFamily,
  menuState,
  menuRef,
  searchBackground,
  fontFamily,
  handleMenuCopy,
  handleMenuPaste,
  handleMenuSelectAll,
  handleMenuCopyAll,
  handleMenuClear,
  hasManageActions,
  onNewTab,
  runMenuAction,
  onCloseSession,
  onCloseOthers,
  onCloseToLeft,
  onCloseToRight,
  onSplitRight,
  onSplitDown,
  runSplitMenuAction,
}: ReturnType<typeof useXTermController>) {
  return (
    <div
      ref={wrapperRef}
      className="ui-terminal-bg-layer relative h-full w-full overflow-hidden"
      style={wrapperStyle}
      data-bg-enabled={showLocalBackgroundImage ? "true" : undefined}
      data-bg-fit={showLocalBackgroundImage ? background.fit : undefined}
      data-bg-position={showLocalBackgroundImage ? background.position : undefined}
      data-workspace-bg-enabled={showWorkspaceBackground ? "true" : undefined}
    >
      {markdownPreviewButtonVisible && (
        <button
          type="button"
          onClick={() => {
            if (!markdownPreviewOpen && !markdownPreviewCanOpen) return;
            setMarkdownPreviewOpen((open) => !open);
          }}
          disabled={!markdownPreviewOpen && !markdownPreviewCanOpen}
          className="terminal-markdown-preview-toggle ui-focus-ring absolute top-3 z-20 inline-flex h-8 w-8 items-center justify-center rounded-md border backdrop-blur-md transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          style={{ ...terminalSearchButtonStyle, right: markdownPreviewRightOffset }}
          aria-label={markdownPreviewOpen
            ? t("terminal.markdownPreview.close")
            : markdownPreviewCanOpen
              ? t("terminal.markdownPreview.open")
              : t("terminal.markdownPreview.unavailable")}
          title={markdownPreviewOpen
            ? t("terminal.markdownPreview.close")
            : markdownPreviewCanOpen
              ? t("terminal.markdownPreview.open")
              : t("terminal.markdownPreview.unavailable")}
          aria-pressed={markdownPreviewOpen}
        >
          {markdownPreviewOpen ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        </button>
      )}
      {searchOpen && (
        <div
          className="terminal-search-shell absolute right-3 top-3 z-20 flex h-8 items-center gap-1 rounded-md border px-2 text-[12px] backdrop-blur-md"
          style={terminalSearchShellStyle}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <span className="select-none font-mono text-[13px] opacity-70" aria-hidden="true">/</span>
          <input
            ref={searchInputRef}
            value={searchTerm}
            onChange={(e) => handleSearchTermChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                runTerminalSearch(searchTerm, e.shiftKey ? "previous" : "next");
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                runTerminalSearch(searchTerm, "next");
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                runTerminalSearch(searchTerm, "previous");
              }
              if (e.key === "Escape") {
                e.preventDefault();
                closeTerminalSearch();
              }
            }}
            className="h-6 w-44 min-w-0 bg-transparent px-1 font-mono text-[12px] outline-none placeholder:opacity-55"
            style={terminalSearchInputStyle}
            placeholder="search"
            aria-label="搜索终端输出"
          />
          <span className="w-12 select-none text-right font-mono text-[11px] opacity-70" aria-live="polite">
            {searchResultLabel}
          </span>
          <button
            type="button"
            disabled={!searchTerm}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runTerminalSearch(searchTerm, "previous")}
            className="flex h-5 w-5 items-center justify-center rounded-sm border font-mono text-[11px] outline-none disabled:opacity-35"
            style={terminalSearchButtonStyle}
            aria-label="上一个匹配"
            title="上一个匹配"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={!searchTerm}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => runTerminalSearch(searchTerm, "next")}
            className="flex h-5 w-5 items-center justify-center rounded-sm border font-mono text-[11px] outline-none disabled:opacity-35"
            style={terminalSearchButtonStyle}
            aria-label="下一个匹配"
            title="下一个匹配"
          >
            ↓
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={closeTerminalSearch}
            className="flex h-5 w-5 items-center justify-center rounded-sm border font-mono text-[11px] outline-none"
            style={terminalSearchButtonStyle}
            aria-label="关闭搜索"
            title="关闭搜索"
          >
            x
          </button>
        </div>
      )}
      <div className="absolute inset-0 overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 min-w-0 overflow-hidden"
          style={{ width: markdownPreviewOpen ? `${100 - markdownPreviewPanelPercent}%` : "100%" }}
          onWheelCapture={handleTerminalFontSizeWheel}
        >
          <div ref={containerRef} className="relative h-full w-full overflow-hidden pl-2" style={terminalContainerStyle} />
          {(isScrolledAwayFromBottom || fontSizeControlVisible) && (
            <div className="absolute bottom-3 right-3 z-20 flex flex-col items-end gap-2">
              {isScrolledAwayFromBottom && (
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={handleScrollToBottom}
                  className="terminal-scroll-to-bottom ui-focus-ring inline-flex h-7 w-7 items-center justify-center rounded-full border backdrop-blur-md transition hover:brightness-110"
                  style={terminalFontSizeControlStyle}
                  aria-label={t("terminal.scrollToBottom")}
                  title={t("terminal.scrollToBottom")}
                >
                  <ArrowDown size={14} aria-hidden="true" />
                </button>
              )}
              {fontSizeControlVisible && (
                <FontSizeControl
                  fontSize={fontSize}
                  defaultFontSize={TERMINAL_FONT_SIZE_DEFAULT}
                  min={TERMINAL_FONT_SIZE_MIN}
                  max={TERMINAL_FONT_SIZE_MAX}
                  onChange={(next) => {
                    showFontSizeControl();
                    void updateSettings("fontSize", next);
                  }}
                  style={terminalFontSizeControlStyle}
                  variant="terminal"
                />
              )}
            </div>
          )}
        </div>
        {markdownPreviewOpen && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t("terminal.markdownPreview.resize")}
            className="absolute inset-y-0 z-20 w-1 -translate-x-1/2 cursor-col-resize bg-transparent transition-colors hover:bg-[color-mix(in_srgb,var(--primary)_55%,transparent)]"
            style={{ left: `${100 - markdownPreviewPanelPercent}%` }}
            onPointerDown={handleMarkdownPreviewResizeStart}
          />
        )}
        <div
          className="absolute inset-y-0 right-0 min-w-0 overflow-hidden"
          style={{ width: markdownPreviewOpen ? `${markdownPreviewPanelPercent}%` : "0%", pointerEvents: markdownPreviewOpen ? "auto" : "none" }}
        >
          <TerminalMarkdownPreview
            sessionId={sessionId}
            open={markdownPreviewOpen}
            onClose={() => setMarkdownPreviewOpen(false)}
          />
        </div>
      </div>
      {terminalInputSuggestionsEnabled && isActive && isVisible && !searchOpen && suggestionGhost && (
        <div
          aria-hidden="true"
          className="terminal-input-suggestion-ghost"
          style={{
            left: suggestionGhost.left,
            top: suggestionGhost.top,
            height: suggestionGhost.height,
            maxWidth: suggestionGhost.maxWidth,
            lineHeight: `${suggestionGhost.height}px`,
            color: searchForeground,
            fontFamily: effectiveFontFamily,
            fontSize,
          }}
        >
          {suggestionGhost.suffix}
        </div>
      )}
      {menuState && (
        <Portal>
          <div
            ref={menuRef}
            className="terminal-context-menu"
            role="menu"
            style={{
              left: Math.max(8, Math.min(menuState.x, window.innerWidth - 190)),
              top: Math.max(8, Math.min(menuState.y, window.innerHeight - 320)),
              "--menu-fg": searchForeground,
              "--menu-bg": searchBackground,
              "--menu-border": hexToRgba(searchForeground, 0.18, "rgba(255, 255, 255, 0.18)"),
              "--menu-hover": hexToRgba(searchForeground, 0.12, "rgba(255, 255, 255, 0.12)"),
              fontFamily,
            } as CSSProperties}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              disabled={!menuState.hasSelection}
              onClick={handleMenuCopy}
            >
              <span>{t("terminal.contextMenu.copy")}</span>
              <span className="terminal-context-menu-hint">Ctrl+C</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              onClick={handleMenuPaste}
            >
              <span>{t("terminal.contextMenu.paste")}</span>
              <span className="terminal-context-menu-hint">Ctrl+V</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              onClick={handleMenuSelectAll}
            >
              <span>{t("terminal.contextMenu.selectAll")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              onClick={handleMenuCopyAll}
            >
              <span>{t("terminal.contextMenu.copyAll")}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="terminal-context-menu-item"
              onClick={handleMenuClear}
            >
              <span>{t("terminal.contextMenu.clear")}</span>
            </button>
            {hasManageActions && (
              <>
                <div className="terminal-context-menu-separator" role="separator" />
                {onNewTab && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runMenuAction(onNewTab)}
                  >
                    <span>{t("terminal.toolbar.newTerminal")}</span>
                  </button>
                )}
                {onCloseSession && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runMenuAction(onCloseSession)}
                  >
                    <span>{t("terminal.tab.closeCurrent")}</span>
                  </button>
                )}
                {onCloseOthers && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runMenuAction(onCloseOthers)}
                  >
                    <span>{t("terminal.tab.closeOthers")}</span>
                  </button>
                )}
                {onCloseToLeft && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runMenuAction(onCloseToLeft)}
                  >
                    <span>{t("terminal.tab.closeLeft")}</span>
                  </button>
                )}
                {onCloseToRight && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runMenuAction(onCloseToRight)}
                  >
                    <span>{t("terminal.tab.closeRight")}</span>
                  </button>
                )}
                {(onSplitRight || onSplitDown) && <div className="terminal-context-menu-separator" role="separator" />}
                {onSplitRight && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runSplitMenuAction(onSplitRight)}
                  >
                    <span>{t("terminal.tab.splitRight")}</span>
                  </button>
                )}
                {onSplitDown && (
                  <button
                    type="button"
                    role="menuitem"
                    className="terminal-context-menu-item"
                    onClick={() => runSplitMenuAction(onSplitDown)}
                  >
                    <span>{t("terminal.tab.splitDown")}</span>
                  </button>
                )}
              </>
            )}
          </div>
        </Portal>
      )}
    </div>
  );
}
