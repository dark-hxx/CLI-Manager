# Web UI Visual Guidelines

> The Web application uses a macOS-inspired frosted-glass, clean white visual language.

---

## Core Direction

- Use warm white and cool light-gray backgrounds with restrained blue accents.
- Keep layouts spacious, quiet, and content-first. Avoid decorative color blocks.
- Use frosted glass only for layered surfaces such as navigation, toolbars, drawers, dialogs, popovers, and floating controls.
- Keep primary content cards mostly opaque so text, tables, code, and charts remain readable.
- Preserve the same component hierarchy and interaction positions across light, dark, and system themes.

## Surface Contract

| Surface | Required treatment |
|---|---|
| Page background | Soft white or light cool-gray base; subtle ambient tint is allowed |
| Primary content | Opaque or near-opaque white surface |
| Navigation / toolbar | Translucent white surface with backdrop blur |
| Drawer / dialog / popover | Frosted surface with stronger blur, thin light border, and soft shadow |
| Selected state | Low-saturation blue tint plus border or text emphasis |
| Code / Diff / logs | Dedicated high-contrast opaque surface; never place dense code directly on glass |

Recommended light-theme starting values:

```css
--web-background: #f3f5f8;
--web-surface: rgba(255, 255, 255, 0.88);
--web-glass: rgba(255, 255, 255, 0.68);
--web-glass-border: rgba(255, 255, 255, 0.72);
--web-border: rgba(15, 23, 42, 0.08);
--web-text: #1d1d1f;
--web-muted: #6e6e73;
--web-primary: #007aff;
--web-shadow: 0 12px 36px rgba(15, 23, 42, 0.10);
--web-blur: blur(20px) saturate(140%);
```

These values are semantic defaults, not permission to hard-code colors inside components. Components must consume shared theme tokens.

## Shape and Depth

- Use 12–16px corner radii for cards and controls; dialogs and major floating panels may use 18–24px.
- Use thin, low-contrast borders and one soft shadow layer. Avoid heavy black shadows.
- Use blur to express hierarchy, not as decoration. Do not stack multiple translucent surfaces without a readable opaque fallback.
- Hover and pressed states may adjust tint, border, or shadow; they must not scale controls or shift layout.

## Accessibility and Fallbacks

- Text contrast must remain at least 4.5:1. Increase surface opacity when the background reduces readability.
- Provide an opaque fallback when `backdrop-filter` is unavailable.
- Respect `prefers-reduced-transparency` where supported by switching glass surfaces to near-opaque surfaces.
- Respect `prefers-reduced-motion`; glass transitions must not be required to understand state changes.
- Status must use text or icons in addition to color.

## Wrong vs Correct

### Wrong

```css
.card {
  background: rgba(255, 255, 255, 0.25);
  backdrop-filter: blur(40px);
}
```

Applying transparent glass to every card reduces hierarchy and makes dense content dependent on the background.

### Correct

```css
.toolbar {
  background: var(--web-glass);
  border: 1px solid var(--web-glass-border);
  backdrop-filter: var(--web-blur);
}

.content-card {
  background: var(--web-surface);
  border: 1px solid var(--web-border);
}
```

Use glass for layered chrome and stable near-opaque surfaces for primary content.

