# Design

Extract only data from i18n using the installed TypeScript AST. Runtime functions and
settings-store access stay at the stable `src/lib/i18n.ts` entry in this batch.
Pure domain dictionaries live under shared/i18n/messages; an explicit index composes them.
English types remain keyed against Chinese. Do not reorder keys within a domain or change values.

Split CSS at existing top-level rule boundaries into named responsibility sections.
Keep the original entry as an ordered import manifest, preserve cascade and resolve the
font URL relative to its new file. Source tests expand the actual import manifest.

Scenarios: zh-CN/en-US/converted zh-TW and auto language; light/dark, terminal image,
compact/sidebar, split/Workspan, history/Markdown. None of their behavior is intentionally changed.
No IPC, DB, PTY, SSH, hook or process code changes in this batch.
