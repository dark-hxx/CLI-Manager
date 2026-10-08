# DeepSeek Harness TUI Contracts

## Ownership and capabilities

The single managed DeepSeek entry is the official DSH host plus its `dsh-tui` plugin profile. DSH owns Agent execution, profile composition, models and persistence; dsh-TUI owns the terminal UI. CLI-Manager owns project configuration, PTY/daemon lifecycle and explicit per-Tab conversation identity. Do not start the official Web profile, allocate Web ports, parse Web readiness or expose a browser-opening button for DSH.

Do not register a native history/Token source, provider type, Hook notification source or MCP/Skills adapter for DSH without a separate integration. Conversation resume is supported through the plugin's explicit UUID environment contract, not through another CLI's history or Hook implementation.

## Default launch and migration

Project setup uses only the ordinary CLI/args/shell/environment fields, including creation, editing and cloning. Do not render a DSH-specific Advanced options section or source-directory picker. Existing source environment keys and explicit source commands remain compatible with the backend; removing UI does not silently rewrite saved project configuration.

- Installed mode defaults to the plugin’s native `dsh-tui` launcher; recognized aliases may keep `dst`. The launcher delegates to the installed profile and official `dsh` host. Existing legacy DSH identities migrate to the TUI launcher without silently expanding it to a direct host command. The profile must already be prepared, so manager preflight does not invoke the launcher’s installation bootstrap.
- Execute installed launchers unchanged after read-only preflight: no manager patch, React preload, NODE_OPTIONS wrapper or fresh-resume Shell prefix. Preserve user environment and arguments. Explicit resume IDs still travel through the per-PTY environment; native TUI owns default session selection and new UUIDs are not automatically captured. Remove previously saved reserved manager overlays using the read-only app-cache ownership hint, retaining user patches and literal prompt arguments. This applies to native shells and guest launchers.
- Local source: preserve `CLI_MANAGER_DSH_SOURCE_ROOT` in existing project `env_vars`; run `node <root>/apps/cli/lib/bin.js --profile dsh-tui`, with literal quoting for the selected shell. Root selection changes the executable only; project/Worktree cwd remains unchanged.
- Default legacy `dsh` configuration migrates known generated Web defaults: Web profile becomes TUI; port 0 and no-open arguments are removed. Reject other Web-only flags and non-TUI profiles. Do not rewrite arbitrary custom shell scripts into managed TUI commands; a DSH custom command must satisfy the recognized TUI launch contract.
- Preserve literal argument and `--` prompt boundaries. Extract only host-position explicit `--resume <ID>` into `DSH_TUI_RESUME_SESSION`; reject bare continue, bare resume and invalid IDs. Explicit input IDs use a bounded safe-character contract; automatically observed native identities must be UUIDs. Repeated equal selectors are accepted; conflicting explicit selectors are rejected. Do not consume resume-looking text after the application separator.
- TUI command restoration must remove a prior resume selector before adding the current saved UUID. Unknown identity starts a new conversation; never infer identity from cwd, an Agent's session, arbitrary stdout text or a global most-recent pointer.

## Read-only native preflight

`deepseek_tui_preflight(sourceRoot?, envVars?)` returns optional host entry path plus source/profile version metadata and an optional `managerPatchPath` ownership hint under the app cache. The hint identifies the reserved cache parent without creating any file. It does not import or execute selected package code, install dependencies, run builds, bootstrap a missing profile or write user configuration.

- Source roots must be absolute canonical directories with bounded official root package metadata (`@deepseek-ai/dsh-root`), existing `apps/cli/lib/bin.js` and `node_modules`. Web artifacts are irrelevant.
- Native node must exist on the effective PATH; installed mode also requires both official `dsh` and `dsh-tui` launchers on PATH. A missing plugin launcher returns `deepseek_tui_launcher_missing`; source-host advanced mode does not require either global executable. Presence checks avoid executing selected code. This does not prove every transitive dependency is compatible; actual launch remains authoritative.
- Resolve explicit/inherited `DSH_HOME`, supported tilde prefixes or the OS home default. Reject an ambiguous relative home because preflight has no project cwd. Project environment overrides are inspected without returning credentials.
- Require the existing `profiles/dsh-tui/package.json` to mount `@deepseek-harness-tui/dsh-tui` in `dsh.profile.bundles`. Verify bounded plugin metadata, its exported/main JS entry and bundle patch files. Missing profile and installed-but-unbuilt plugin produce distinct stable errors.
- Ordinary launcher preflight does not depend on private registry artifacts or pin a plugin release line. Only `deepseek_tui_prepare_launch` for legacy direct-host commands requires bridge compatibility: the `0.12.x` line and existing `lib/types/adapter/channel/host-registry.js` artifact. Unsupported bridge versions/files return `deepseek_tui_bridge_unsupported`. Do not describe this private interface as a stable public upstream contract.
- Default native project save and native launch perform preflight. Guest installations are not inspected using the host filesystem.

## Legacy direct-host bridge overlay

The following overlay/preload rules apply only to recognized direct official-host commands, including existing source-host configuration. Default `dsh-tui`/`dst` execution never uses this compatibility path.

`deepseek_tui_prepare_launch(sourceRoot?, envVars?)` revalidates the native host/profile, then returns `patchPath`, `preloadPath`, `preloadUrl` and `cmdPreloadPath` for manager-owned launch code. It writes only the application cache. The overlay inserts `cli-manager-deepseek-tui-bridge` from `./bridge.mjs`; append it after user patches and before the host/application separator.

- Embed the manager bridge, hash its code plus overlay and use immutable content-addressed cache directories. Publish complete files atomically; concurrent Tab launches may share the same code. Do not cache credentials or per-Tab session state.
- Hash and publish the React preload and static CMD scope template in the same cache. The generated CMD file contains only its percent-escaped preload file URL, never user options or startup arguments. Keep all four files complete under concurrent publication.
- A global host can choose its global TUI bundle while a linked profile imports local TUI components. SDK peer interception then uses the global bundle declarer, creating a second React dispatcher. In managed native TUI host processes only, the preload captures the actual installation-first bundle React exports before SDK hooks; a scoped resolve hook activates before TUI component imports and normalizes React, both JSX runtimes and compiler-runtime to that owner. Retain all non-React resolution and source text; do not change built-in bundle priority. Other Node entry points, version/plugin subcommands, unmanaged hosts and other profiles skip activation.
- An ordinary installed profile already has a coherent renderer/hooks closure. Skip registration when the resolved TUI package remains inside the canonical profile tree (including internal dependency links). Only external source links may activate the compatibility preload. Applying this hook to a normal profile can split React between the renderer and external hooks and cause `useRef` to read a null dispatcher.
- Add the preload to the actual initialized shell's `NODE_OPTIONS` only during the startup command. PowerShell uses a local scriptblock with try/finally restoring value/existence; POSIX uses a subshell; fish uses a local exported scope; CMD uses immutable setlocal batch code with safe delayed expansion for options and disables it before forwarding CLI arguments. A child `cmd /d /v:off /s /c` with caret-escaped outer quotes retains the scope across npm batch launchers; direct `%*` tail calls lose it, while unescaped whole-command quotes can reinterpret quoted `&` arguments. Do not overwrite `NODE_OPTIONS` in the PTY environment or save this wrapper as startup metadata. Resolve explicit launch identity from the stable command even when execution is wrapped.
- The adapter imports the verified plugin's internal host registry through its actual profile package resolution and uses the composition-root Channel registration identity. It only reads `channel.sessionId` and subscribes to registration/channel changes. Do not call private Agent/session actions or rewrite plugin/profile/source files.
- Read the existing per-PTY `CLI_MANAGER_TAB_ID`, validate terminal and foreground conversation UUIDs, and emit `OSC 777;cli-manager-dsh-tui;<PTY UUID>;<conversation UUID>`. Subscribe before reading the initial state; release old channel subscriptions on registration replacement and all subscriptions on disposal.
- Persist the stable pre-overlay command separately from the actual execution command. Remove only prior reserved manager bridge paths in the same cache parent; retain user patches and literal prompt text.
- A fresh launch must actually unset `DSH_TUI_RESUME_SESSION` in the selected shell before starting DSH; an empty value is an explicit invalid resume target in TUI 0.12. Keep this transient shell wrapper out of saved startup metadata.
- Preserve Node mode overrides; use production as the default for TUI to match its launcher and avoid React development instrumentation growth.
- For `dsh-tui`/`dst`, place managed host patch flags after existing leading host flags and before the first application token, because upstream classifies only the leading host prefix. Do not add another automatic host/app separator: the upstream launcher inserts that boundary itself; explicit application separators remain literal.

## PTY observation, identity and restoration

- Observe existing deduplicated raw PTY frames independently of active UI consumers. Preserve terminal display, ACK ownership, flow control and replay ordering.
- Parse the dedicated OSC across UTF-8/frame boundaries, accepting BEL and ST terminators. Bound retained partial protocol text to 512 characters; validate both UUIDs and the owning PTY before reporting identity. Ignore malformed or other-session metadata.
- Terminal state is the only identity owner. Bind UUID updates to that Tab and persist them through the existing session store; sidebar resume uses the same explicit identity. Track foreground channel changes, not a directory-level latest session.
- Reset protocol readers on replay/reset and release them on close/closeAll. Live daemon attach must reuse the existing process; a saved UUID remains available even when retained replay omits the original metadata.
- A dead process performs fresh preflight and restores only a valid saved conversation UUID. Default launchers execute natively without overlay; only legacy direct-host commands stage the bridge. Do not replay old TUI scrollback over its newly rendered UI. Missing identity returns to the native TUI session interface.

## WSL and SSH boundaries

- Projectless TUI sessions saved to sidebar retain their original session environment along with the stable command and explicit UUID. Existing projects retain their own serialized environment.
- Literal command tokenization rejects unquoted shell chains, pipes, redirections and newlines; the leading PowerShell call operator is supported. Quoted argument values remain literal, including operator characters.

- Guests use their own installed `dsh-tui` launcher, official host and existing `dsh-tui` profile. Reject host source roots for WSL/SSH; do not stage host cache overlays or run native filesystem preflight against guests.
- Explicit known conversation IDs travel through existing environment transport. WSL extends its forwarding allowlist with `DSH_TUI_RESUME_SESSION`, `DSH_HOME` and `NODE_ENV`, preserving existing WSLENV entries and flags. Do not automatically map a host home path into a Linux profile path.
- This batch does not provision the manager identity bridge inside guests. Newly created guest conversation UUIDs are not automatically captured. A known explicit/saved UUID can resume; unknown guest identity restarts fresh rather than borrowing a shared recent pointer.
- Guest/full native desktop validation must be reported from actual evidence; pure tests or preflight success do not establish terminal interaction, resize, paste, focus, Ctrl+C or SSH connectivity.

## Required validation

- Command tests: installed/source host, quoting and supported shells, legacy migration, profile enforcement, patch ordering, application separators, explicit/invalid/multiple resume IDs and guest source rejection.
- Rust preflight tests: no Web requirement, official bounded metadata, mounted/built plugin, missing native commands, version/registry compatibility, no implicit writes/install and concurrent immutable bridge publication.
- Runtime/store tests: UTF-8/OSC framing, malformed/wrong-PTY identity, replay/reset, inactive consumers, per-Tab persistence and cleanup, live attach versus dead/unknown restore and sidebar explicit resume.
- WSL environment tests: preserve user WSLENV flags, absence behavior, deduplication and the three DSH launch variables.
- Bridge tests: initial registration, Channel foreground UUID changes, A→B→A identities, old subscription disposal, malformed identities and unsupported registry shape.
- Manual evidence: actual native TUI render/input/paste/resize/Ctrl+C, multiple Tabs, Worktree, save/edit/clone, sidebar resume and zh-CN/en-US; record unavailable guest environments honestly. No paid model call is required for terminal startup checks.
- Delivery checks: targeted tests, frontend type/build, Rust checks, independent strict architecture and diff checks. Preserve archived Web task records as historical evidence.


## Opt-in installed-launcher smoke

`src-tauri/tests/deepseek_tui_smoke.rs` retains the direct source-host mode when `CLI_MANAGER_DSH_TUI_SMOKE_HOST` is supplied. To exercise the actual installed launcher/delegation path, set `CLI_MANAGER_DSH_TUI_SMOKE_LAUNCHER` to the installed package’s `bin/dsh-tui.js`; the test runs it through node with the same manager bridge patch. Use isolated `CLI_MANAGER_DSH_TUI_SMOKE_HOME` and `CLI_MANAGER_DSH_TUI_SMOKE_USER_HOME`; official `dsh` must already resolve on inherited PATH. Both modes run the same render/input/paste/resize/Ctrl+C, exact resume and same-cwd parallel fresh identity checks without model requests or user-profile installation. The same file is also registered under the Windows library-test module `commands::deepseek::tui_smoke`, allowing an exact opt-in `cargo test --lib commands::deepseek::tui_smoke::real_tui_conpty_initial_input_resize_stop_and_exact_resume -- --ignored --nocapture` run without rebuilding the active desktop executable. The test-only self-crate alias and module registration are absent from production builds.
