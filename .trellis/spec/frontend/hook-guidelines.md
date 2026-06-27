# Hook Guidelines

> How hooks are used in this project.

---

## Overview

<!--
Document your project's hook conventions here.

Questions to answer:
- What custom hooks do you have?
- How do you handle data fetching?
- What are the naming conventions?
- How do you share stateful logic?
-->

(To be filled by the team)

---

## Custom Hook Patterns

<!-- How to create and structure custom hooks -->

(To be filled by the team)

---

## Data Fetching

<!-- How data fetching is handled (React Query, SWR, etc.) -->

(To be filled by the team)

---

## Naming Conventions

<!-- Hook naming rules (use*, etc.) -->

(To be filled by the team)

---

## Common Mistakes

### Common Mistake: Returning before all hooks in visibility-gated panels

**Symptom**: Switching a panel from visible to hidden throws `Rendered fewer hooks than expected` and can blank the React view.

**Cause**: A component calls a hook after an early return such as `if (!open || !visible) return null;`. When the same mounted component later becomes hidden, React sees fewer hooks than the previous render.

**Fix**: Keep every hook call before any render guard. It is fine to compute cheap derived values before returning `null`.

```tsx
// Wrong
const value = useMemo(() => buildValue(input), [input]);
if (!visible) return null;
const other = useMemo(() => buildOther(value), [value]);

// Correct
const value = useMemo(() => buildValue(input), [input]);
const other = useMemo(() => buildOther(value), [value]);
if (!visible) return null;
```

**Prevention**: In tabbed or side-panel UIs where hidden tabs stay mounted, scan for any `return null` before later `use*` calls before changing visibility behavior.

(To be filled by the team)
