# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

### Don't allocate per item in hot UI scans

**Problem**:
```typescript
for (const message of messages) {
  if (message.content.toLowerCase().includes(query)) {
    // match
  }
}
```

**Why it's bad**: large terminal/history content can make per-message full-string copies dominate CPU and memory.

**Instead**:
```typescript
const matcher = new RegExp(escapeRegExp(query), "i");
for (const message of messages) {
  if (matcher.test(message.content)) {
    // match
  }
}
```

---

## Required Patterns

### Gate diagnostic console output behind Debug Mode

**What**: WebView-side diagnostic `console.log`, `console.info`, and `console.warn` output must go through `src/lib/debugConsole.ts`, not direct `console.*` calls.

**Why**: normal users should not get noisy console diagnostics; Debug Mode is the explicit switch for frontend console diagnostics. Keep real error reporting paths such as `console.error` separate unless the task explicitly changes error reporting.

**Correct**:
```typescript
debugConsoleWarn("[oom-diagnostics:webview]", payload);
```

**Wrong**:
```typescript
console.warn("[oom-diagnostics:webview]", payload);
```

### Bound buffers for hidden terminal output

**What**: when terminal output is buffered while a tab is hidden, keep a fixed-size latest suffix instead of an unbounded list.

**Why**: inactive terminal sessions can receive large output bursts while hidden; unbounded buffering makes memory grow with output volume.

**Example**:
```typescript
if (text.length >= maxBufferBytes) {
  buffer = [text.slice(-maxBufferBytes)];
} else {
  buffer.push(text);
  trimOldestUntilWithinLimit();
}
```

---

## Testing Requirements

### Manual runtime UI verification

AI agents must not start CLI-Manager services or the Tauri desktop app to verify runtime UI behavior. For frontend or terminal visual changes, run static/build checks where relevant, then list the exact manual verification items for a human to check.

**Why**: this project cannot be reliably verified by AI at runtime; manual desktop/UI inspection is the source of truth.

**Required manual checks for terminal UI changes**:
- Normal terminal layout has no unintended one-sided padding or outer gaps.
- Fullscreen terminal layout still fills the available window.
- Terminal background image mode still shows transparency, blur, darken, fit, and position correctly.

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
