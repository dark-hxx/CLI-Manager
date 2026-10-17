---
name: CLI-Manager Tap workspace
description: Quiet session-oriented workspace with a native dark terminal
colors:
  primary: "oklch(.54 .2 280)"
  primary-soft: "primary at 9%"
  background: "oklch(1 0 0)"
  surface: "oklch(.985 .002 285.82)"
  muted: "oklch(.965 .003 285.82)"
  foreground: "oklch(.145 .014 285.82)"
  secondary: "oklch(.52 .014 285.82)"
  line: "oklch(.922 .003 285.82)"
  bubble: "oklch(.935 .04 283)"
  terminal: "#1c1b22"
  terminal-text: "#e4e4e7"
  terminal-cursor: "#c4b5fd"
  dark-background: "oklch(.165 .012 285.82)"
  dark-primary: "oklch(.72 .14 280)"
typography:
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "14px desktop, 13px phone"
    lineHeight: 1.5
  conversation: "15px desktop, 14px phone (12-22, user setting), line-height 1.6"
  composer: "14px desktop, 15px phone"
  title: "14px/600 desktop, 13.5px/600 phone"
  meta: "12px desktop, 10.5px mono phone subtitle"
  terminal: "13px system mono (desktop), 12px Tap Mono (phone), 9-22"
rounded:
  key: "8px (7px phone)"
  control: "8px"
  menu: "10px"
  terminal: "12px (10px phone)"
  bubble: "12px"
  composer: "16px (14px phone)"
  sheet: "14px desktop, 16px top corners phone"
spacing:
  key-gap: "6px (4px phone)"
  stage: "12px 16px (6px phone)"
  chat-column: "min(100%, max(760px, 78cqi), 1180px)"
layout:
  sidebar: "272px"
  side-panel: "320px, docked at >= 1152px"
  phone-drawer: "min(86vw, 340px)"
---

# Design System: Tap workspace

## Overview

This Operate surface preserves the user's established Tap-Code direction: quiet neutral workspace, folder-grouped sessions, native dark terminal, a bottom composer with a two-row key strip, and phone-first gestures. Product truth and constraints live in `PRODUCT.md`; this record describes the implemented visual system, not additional feature promises.

This scope is `apps/web-tap` only. Classic Web keeps its own glass/blue visual guidelines. Source of truth: `src/styles.css` (tokens, shell, menus, overlays), `src/session.css` (terminal, conversation, dock) and `src/panels.css` (sidebar, side panel, settings).

## Colors

Violet marks selection, running state, focus and the send action. Neutral tonal surfaces carry hierarchy; muted foreground is readable content, not disabled decoration. Status colors always accompany text or an icon: green connection dot, red blinking dot when the link drops, violet running dot, hollow ring when ended. The user bubble is a violet tint, never dark, so it cannot be confused with code.

Dark mode replaces surface/text/border tokens without changing composition. The native terminal and code blocks stay `#1c1b22` in either theme.

## Typography

System sans carries UI and conversation text; mono carries terminal geometry, paths, branch names and the phone subtitle. The OFL Inconsolata face (Tap Mono) narrows Latin glyphs on phones. Times are 24-hour; counts use tabular numbers. Meta rows use one font with 3px CSS-drawn dots so separators align.

## Layout

Desktop: a 272px sidebar, the session column, and an optional 320px side panel that docks when the window is at least 1152px wide and floats over a light scrim otherwise. Chat and composer share one column width that grows with the window. Phone: the topbar holds only the navigation button, title block, view toggle, side-panel button and the ⋯ menu; the sidebar and side panel become edge-swipe drawers.

The dock is ordered key strip → composer → one status row. The key strip appears only in terminal view (default on for touch) and steps aside while a message is being written. The status row shows terminal size, project, Git branch and +N −M only; data CLI-Manager does not report (model, usage, limits) is absent rather than explained.

The keyboard translates the app shell rather than shrinking content. Desktop grid ownership is separate from browser layout; the phone reading view reflows text and clips drawn rules instead of wrapping them.

## Elevation & Depth

The workspace is flat with one-pixel borders. The composer, floating buttons and menus use a soft float shadow; sheets, drawers and the floating side panel use the overlay shadow with a scrim. Menus open in 200ms, sheets in 250-320ms, drawers in 320ms; exits are shorter. Reduced motion disables all of it.

## Components

- Session rows: CLI brand icon with a status dot, readable topic, optional worktree badge, opaque violet-tint selection and a left mark for sessions kept mounted. Folder rows show the running count.
- Topbar: status glyph + title; phone subtitle `project · cli · cols×rows`; segmented chat/terminal toggle; desktop crumb and +N −M chip that toggles the side panel.
- ⋯ menu: terminal font stepper, settings, and a danger "End session…" that turns the menu into an inline confirmation tied to that session.
- Composer: multiline textarea with agent-specific placeholder, "+" menu (image, type directly), interrupt, round send button; disabled state keeps the draft and names the reason.
- Conversation: right-aligned user bubble (long prompts clamp with "Show more"), unboxed assistant Markdown, interim replies folded into one row per turn, a footer with copy and time, and a "jump to latest" button with an unread dot.
- Process steps (from Tap-Code): one compact row per tool call behind a thin left rule (chevron, muted icon, localized verb, mono key parameter, right-aligned +N −M or exit code). Details stay folded; diffs use tinted add/delete lines with a sign column (line numbers only when known), command output sits in the same `#1c1b22` block as the terminal, task lists use status circles. The turn footer adds elapsed time and +N −M ("~" when incomplete); a tick rail on the right and a search bar above the column navigate loaded turns.
- Side panel: segmented Details / Changes / Files tabs, Git status letters, file and diff previews with a back header.
- Overlays: portal layer with backdrop siblings; no `inert`/`showModal()`. Only the top overlay handles Escape and Tab; touch never steals focus or reopens the keyboard.

## Do's and Don'ts

- Do preserve hierarchy, spacing and action positions in both languages and themes.
- Do keep offline, ended, unsupported and uncertain-delivery states explicit.
- Do use the native terminal for native permissions and menus.
- Don't show controls for unavailable queue/Push/usage/model capabilities.
- Don't use native `<select>` menus or one-tap destructive actions.
- Don't import Classic Web view/state modules to approximate this identity.
- Don't shrink a desktop-owned terminal into unreadable phone text; offer the explicit reading/native toggle.
