# Hook Guidelines

## Hooks Must Precede Visibility Guards

Components that stay mounted while hidden must call every hook before an early render return.
Changing visibility must not change hook order or hook count.

```tsx
// Wrong: hiding the panel skips a later hook.
const value = useMemo(() => buildValue(input), [input]);
if (!visible) return null;
const other = useMemo(() => buildOther(value), [value]);

// Correct: hooks run before the render guard.
const value = useMemo(() => buildValue(input), [input]);
const other = useMemo(() => buildOther(value), [value]);
if (!visible) return null;
```

Before changing tab or side-panel visibility, check for `return null` before later `use*` calls.
