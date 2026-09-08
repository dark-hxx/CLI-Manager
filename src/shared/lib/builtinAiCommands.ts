export type BuiltinAiCommandTool =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "aider"
  | "opencode"
  | "github-copilot";

export type BuiltinAiCommandCategory =
  | "launch"
  | "headless"
  | "session"
  | "model"
  | "permission"
  | "mcp"
  | "config"
  | "review"
  | "git"
  | "context"
  | "diagnostic"
  | "auth"
  | "workflow";

export interface BuiltinAiCommand {
  id: string;
  command: string;
  tool: BuiltinAiCommandTool;
  category: BuiltinAiCommandCategory;
  description: string;
  sourceUrl: string;
  interactive: boolean;
  aliases?: string[];
  tags?: string[];
}

const CLAUDE_CLI_REFERENCE = "https://code.claude.com/docs/en/cli-reference";
const CLAUDE_COMMANDS_REFERENCE = "https://code.claude.com/docs/en/commands";
const CODEX_REFERENCE = "https://developers.openai.com/codex/cli/reference";
const CODEX_SLASH_REFERENCE = "https://developers.openai.com/codex/cli/slash-commands";
const GEMINI_COMMANDS_REFERENCE = "https://geminicli.com/docs/reference/commands/";
const AIDER_COMMANDS_REFERENCE = "https://aider.chat/docs/usage/commands.html";
const AIDER_OPTIONS_REFERENCE = "https://aider.chat/docs/usage/options.html";
const OPENCODE_CLI_REFERENCE = "https://opencode.ai/docs/cli/";
const OPENCODE_TUI_REFERENCE = "https://opencode.ai/docs/tui/";
const COPILOT_CLI_REFERENCE =
  "https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference";

const c = (
  id: string,
  command: string,
  tool: BuiltinAiCommandTool,
  category: BuiltinAiCommandCategory,
  description: string,
  sourceUrl: string,
  interactive = false,
  tags: string[] = []
): BuiltinAiCommand => ({
  id,
  command,
  tool,
  category,
  description,
  sourceUrl,
  interactive,
  tags,
});

export const BUILTIN_AI_COMMANDS: readonly BuiltinAiCommand[] = [
  c("claude:start", "claude", "claude-code", "launch", "Start an interactive Claude Code session.", CLAUDE_CLI_REFERENCE),
  c("claude:prompt", 'claude "explain this project"', "claude-code", "launch", "Start Claude Code with an initial prompt.", CLAUDE_CLI_REFERENCE),
  c("claude:print", 'claude -p "explain this function"', "claude-code", "headless", "Run Claude Code print mode and exit.", CLAUDE_CLI_REFERENCE),
  c("claude:pipe", 'cat logs.txt | claude -p "explain"', "claude-code", "headless", "Process piped content with Claude Code print mode.", CLAUDE_CLI_REFERENCE),
  c("claude:continue", "claude --continue", "claude-code", "session", "Continue the most recent conversation in the current directory.", CLAUDE_CLI_REFERENCE),
  c("claude:continue-short", "claude -c", "claude-code", "session", "Short form for continuing the latest conversation.", CLAUDE_CLI_REFERENCE),
  c("claude:continue-print", 'claude -c -p "Check for type errors"', "claude-code", "session", "Continue the latest conversation in print mode.", CLAUDE_CLI_REFERENCE),
  c("claude:resume", "claude --resume auth-refactor", "claude-code", "session", "Resume a named or selected Claude Code session.", CLAUDE_CLI_REFERENCE),
  c("claude:resume-short", 'claude -r "auth-refactor" "Finish this PR"', "claude-code", "session", "Resume a named session and send an initial prompt.", CLAUDE_CLI_REFERENCE),
  c("claude:update", "claude update", "claude-code", "config", "Update Claude Code to the latest version.", CLAUDE_CLI_REFERENCE),
  c("claude:install", "claude install stable", "claude-code", "config", "Install or reinstall the stable native binary.", CLAUDE_CLI_REFERENCE),
  c("claude:auth-login", "claude auth login", "claude-code", "auth", "Sign in to an Anthropic account.", CLAUDE_CLI_REFERENCE),
  c("claude:auth-console", "claude auth login --console", "claude-code", "auth", "Sign in with Anthropic Console for API usage billing.", CLAUDE_CLI_REFERENCE),
  c("claude:auth-status", "claude auth status", "claude-code", "auth", "Show Claude Code authentication status.", CLAUDE_CLI_REFERENCE),
  c("claude:auth-logout", "claude auth logout", "claude-code", "auth", "Log out from Claude Code.", CLAUDE_CLI_REFERENCE),
  c("claude:agents", "claude agents", "claude-code", "workflow", "Open agent view for background sessions.", CLAUDE_CLI_REFERENCE),
  c("claude:agents-json", "claude agents --json", "claude-code", "workflow", "Print active background sessions as JSON.", CLAUDE_CLI_REFERENCE),
  c("claude:attach", "claude attach <session-id>", "claude-code", "session", "Attach to a Claude Code background session.", CLAUDE_CLI_REFERENCE),
  c("claude:logs", "claude logs <session-id>", "claude-code", "diagnostic", "Print recent output from a background session.", CLAUDE_CLI_REFERENCE),
  c("claude:respawn", "claude respawn <session-id>", "claude-code", "session", "Restart a background session with its conversation intact.", CLAUDE_CLI_REFERENCE),
  c("claude:rm", "claude rm <session-id>", "claude-code", "session", "Remove a background session from the list.", CLAUDE_CLI_REFERENCE),
  c("claude:daemon-status", "claude daemon status", "claude-code", "diagnostic", "Inspect the background-session supervisor.", CLAUDE_CLI_REFERENCE),
  c("claude:daemon-stop", "claude daemon stop --any --keep-workers", "claude-code", "diagnostic", "Stop the background supervisor while keeping workers.", CLAUDE_CLI_REFERENCE),
  c("claude:mcp", "claude mcp", "claude-code", "mcp", "Configure Model Context Protocol servers.", CLAUDE_CLI_REFERENCE),
  c("claude:mcp-login", "claude mcp login sentry", "claude-code", "mcp", "Run OAuth login for a configured MCP server.", CLAUDE_CLI_REFERENCE),
  c("claude:mcp-logout", "claude mcp logout sentry", "claude-code", "mcp", "Clear OAuth credentials for a configured MCP server.", CLAUDE_CLI_REFERENCE),
  c("claude:plugin", "claude plugin", "claude-code", "config", "Manage Claude Code plugins.", CLAUDE_CLI_REFERENCE),
  c("claude:project-purge", "claude project purge . --dry-run", "claude-code", "diagnostic", "Preview clearing local Claude Code state for a project.", CLAUDE_CLI_REFERENCE),
  c("claude:model-sonnet", "claude --model sonnet", "claude-code", "model", "Start Claude Code with the Sonnet model alias.", CLAUDE_CLI_REFERENCE),
  c("claude:model-opus", "claude --model opus", "claude-code", "model", "Start Claude Code with the Opus model alias.", CLAUDE_CLI_REFERENCE),
  c("claude:permission-plan", "claude --permission-mode plan", "claude-code", "permission", "Start in plan permission mode.", CLAUDE_CLI_REFERENCE),
  c("claude:permission-accept", "claude --permission-mode acceptEdits", "claude-code", "permission", "Start with edit acceptance permission mode.", CLAUDE_CLI_REFERENCE),
  c("claude:permission-auto", "claude --permission-mode auto", "claude-code", "permission", "Start in auto permission mode.", CLAUDE_CLI_REFERENCE),
  c("claude:permission-bypass", "claude --dangerously-skip-permissions", "claude-code", "permission", "Start with permission prompts bypassed.", CLAUDE_CLI_REFERENCE),
  c("claude:add-dir", "claude --add-dir <path>", "claude-code", "permission", "Grant access to an additional directory for the session.", CLAUDE_CLI_REFERENCE),
  c("claude:mcp-config", "claude --mcp-config ./mcp.json", "claude-code", "mcp", "Start with an explicit MCP config file.", CLAUDE_CLI_REFERENCE),
  c("claude:strict-mcp", "claude --strict-mcp-config --mcp-config ./mcp.json", "claude-code", "mcp", "Use only MCP servers from the supplied config.", CLAUDE_CLI_REFERENCE),
  c("claude:settings", "claude --settings ./settings.json", "claude-code", "config", "Override settings for the current invocation.", CLAUDE_CLI_REFERENCE),
  c("claude:safe-mode", "claude --safe-mode", "claude-code", "diagnostic", "Start with customizations disabled for troubleshooting.", CLAUDE_CLI_REFERENCE),
  c("claude:json", 'claude -p "query" --output-format json', "claude-code", "headless", "Run print mode and return JSON output.", CLAUDE_CLI_REFERENCE),
  c("claude:stream-json", 'claude -p --output-format stream-json --verbose "query"', "claude-code", "headless", "Run print mode with stream-json output.", CLAUDE_CLI_REFERENCE),
  c("claude:prompt-suggestions", 'claude -p --prompt-suggestions --output-format stream-json --verbose "query"', "claude-code", "headless", "Emit prompt_suggestion events after turns.", CLAUDE_CLI_REFERENCE),
  c("claude:system-prompt", 'claude --system-prompt "You are a Python expert"', "claude-code", "config", "Replace the system prompt for the invocation.", CLAUDE_CLI_REFERENCE),
  c("claude:append-system-prompt", 'claude --append-system-prompt "Always use TypeScript"', "claude-code", "config", "Append instructions to the default system prompt.", CLAUDE_CLI_REFERENCE),
  c("claude:teleport", "claude --teleport", "claude-code", "session", "Resume a web session in the local terminal.", CLAUDE_CLI_REFERENCE),
  c("claude:worktree", "claude --worktree feature-auth", "claude-code", "git", "Start Claude in an isolated git worktree.", CLAUDE_CLI_REFERENCE),
  c("claude:slash-help", "/help", "claude-code", "diagnostic", "Show command help inside Claude Code.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-init", "/init", "claude-code", "config", "Generate a starter CLAUDE.md.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-memory", "/memory", "claude-code", "context", "Edit or refine project memory.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-mcp", "/mcp", "claude-code", "mcp", "Manage MCP servers inside the session.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-permissions", "/permissions", "claude-code", "permission", "Set approval and permission rules.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-plan", "/plan", "claude-code", "workflow", "Switch into plan mode.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-model", "/model", "claude-code", "model", "Switch the current model.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-effort", "/effort", "claude-code", "model", "Adjust reasoning effort.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-context", "/context", "claude-code", "context", "Visualize current context usage.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-compact", "/compact", "claude-code", "context", "Summarize the conversation to free context.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-btw", "/btw ", "claude-code", "context", "Ask a side question without adding to conversation history.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-clear", "/clear", "claude-code", "session", "Start a new conversation while keeping memory.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-resume", "/resume", "claude-code", "session", "Return to an earlier conversation.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-branch", "/branch", "claude-code", "session", "Fork the current conversation into a branch.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-background", "/background", "claude-code", "workflow", "Detach the session to run as a background agent.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-batch", "/batch ", "claude-code", "workflow", "Decompose large codebase work into parallel units.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-diff", "/diff", "claude-code", "git", "Show current code changes.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-review", "/review", "claude-code", "review", "Review a GitHub pull request.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-code-review", "/code-review", "claude-code", "review", "Review the current diff for bugs and cleanups.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-code-review-fix", "/code-review --fix", "claude-code", "review", "Review and apply fixable findings.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-security-review", "/security-review", "claude-code", "review", "Run a deeper read-only security review.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-simplify", "/simplify", "claude-code", "review", "Review changed code for cleanup opportunities.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-rewind", "/rewind", "claude-code", "session", "Roll code and conversation back to a checkpoint.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-doctor", "/doctor", "claude-code", "diagnostic", "Diagnose install and runtime issues.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-debug", "/debug", "claude-code", "diagnostic", "Debug Claude Code runtime behavior.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-status", "/status", "claude-code", "diagnostic", "Open status settings for version, model, account, and connectivity.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-usage", "/usage", "claude-code", "diagnostic", "Show session cost and plan usage.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-tui", "/tui fullscreen", "claude-code", "config", "Switch to fullscreen TUI renderer.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-theme", "/theme", "claude-code", "config", "Change terminal UI theme.", CLAUDE_COMMANDS_REFERENCE, true),
  c("claude:slash-config", "/config", "claude-code", "config", "Open settings or set config keys.", CLAUDE_COMMANDS_REFERENCE, true),

  c("codex:start", "codex", "codex", "launch", "Start an interactive Codex CLI session.", CODEX_REFERENCE),
  c("codex:exec", 'codex exec "explain this project"', "codex", "headless", "Run Codex non-interactively for automation.", CODEX_REFERENCE),
  c("codex:login", "codex login", "codex", "auth", "Sign in to Codex CLI.", CODEX_REFERENCE),
  c("codex:logout", "codex logout", "codex", "auth", "Sign out from Codex CLI.", CODEX_REFERENCE),
  c("codex:resume", "codex resume", "codex", "session", "Resume a previous Codex session.", CODEX_REFERENCE),
  c("codex:mcp", "codex mcp", "codex", "mcp", "Manage Codex MCP servers.", CODEX_REFERENCE),
  c("codex:mcp-add", "codex mcp add <name> -- <command>", "codex", "mcp", "Add an MCP server command.", CODEX_REFERENCE),
  c("codex:mcp-list", "codex mcp list", "codex", "mcp", "List configured MCP servers.", CODEX_REFERENCE),
  c("codex:mcp-remove", "codex mcp remove <name>", "codex", "mcp", "Remove a configured MCP server.", CODEX_REFERENCE),
  c("codex:model", "codex --model gpt-5.1-codex", "codex", "model", "Start Codex with an explicit model.", CODEX_REFERENCE),
  c("codex:sandbox-readonly", "codex --sandbox read-only", "codex", "permission", "Start with read-only sandboxing.", CODEX_REFERENCE),
  c("codex:sandbox-workspace", "codex --sandbox workspace-write", "codex", "permission", "Start with workspace-write sandboxing.", CODEX_REFERENCE),
  c("codex:approval-on-request", "codex --ask-for-approval on-request", "codex", "permission", "Ask before selected privileged actions.", CODEX_REFERENCE),
  c("codex:approval-never", "codex --ask-for-approval never", "codex", "permission", "Run without approval prompts.", CODEX_REFERENCE),
  c("codex:config", 'codex --config model="gpt-5.1-codex"', "codex", "config", "Override a Codex config value for one invocation.", CODEX_REFERENCE),
  c("codex:slash-help", "/help", "codex", "diagnostic", "Show Codex slash command help.", CODEX_SLASH_REFERENCE, true),
  c("codex:slash-clear", "/clear", "codex", "session", "Clear or start a fresh Codex conversation.", CODEX_SLASH_REFERENCE, true),
  c("codex:slash-compact", "/compact", "codex", "context", "Summarize conversation context.", CODEX_SLASH_REFERENCE, true),
  c("codex:slash-model", "/model", "codex", "model", "Change Codex model.", CODEX_SLASH_REFERENCE, true),
  c("codex:slash-status", "/status", "codex", "diagnostic", "Show Codex account/session status.", CODEX_SLASH_REFERENCE, true),
  c("codex:slash-diff", "/diff", "codex", "git", "Show current diff.", CODEX_SLASH_REFERENCE, true),
  c("codex:slash-review", "/review", "codex", "review", "Review current changes.", CODEX_SLASH_REFERENCE, true),
  c("codex:slash-new", "/new", "codex", "session", "Start a new Codex conversation.", CODEX_SLASH_REFERENCE, true),
  c("codex:slash-init", "/init", "codex", "config", "Initialize project guidance for Codex.", CODEX_SLASH_REFERENCE, true),
  c("codex:slash-mcp", "/mcp", "codex", "mcp", "Manage MCP servers from the Codex TUI.", CODEX_SLASH_REFERENCE, true),

  c("gemini:start", "gemini", "gemini-cli", "launch", "Start Gemini CLI.", GEMINI_COMMANDS_REFERENCE),
  c("gemini:model", "gemini --model gemini-2.5-pro", "gemini-cli", "model", "Start Gemini CLI with an explicit model.", GEMINI_COMMANDS_REFERENCE),
  c("gemini:prompt", 'gemini -p "explain this project"', "gemini-cli", "headless", "Send a prompt directly to Gemini CLI.", GEMINI_COMMANDS_REFERENCE),
  c("gemini:slash-help", "/help", "gemini-cli", "diagnostic", "Show Gemini CLI help.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-chat", "/chat save feature-work", "gemini-cli", "session", "Save or resume a conversation checkpoint.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-clear", "/clear", "gemini-cli", "session", "Clear the Gemini CLI screen/session context.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-compress", "/compress", "gemini-cli", "context", "Compress the conversation context.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-memory", "/memory show", "gemini-cli", "context", "Inspect Gemini CLI memory.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-mcp", "/mcp", "gemini-cli", "mcp", "List or inspect MCP servers.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-tools", "/tools", "gemini-cli", "diagnostic", "List available tools.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-stats", "/stats", "gemini-cli", "diagnostic", "Show session statistics.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-theme", "/theme", "gemini-cli", "config", "Change Gemini CLI theme.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-auth", "/auth", "gemini-cli", "auth", "Change authentication method.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-editor", "/editor", "gemini-cli", "config", "Configure external editor integration.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-restore", "/restore", "gemini-cli", "session", "Restore a checkpoint.", GEMINI_COMMANDS_REFERENCE, true),
  c("gemini:slash-quit", "/quit", "gemini-cli", "session", "Quit Gemini CLI.", GEMINI_COMMANDS_REFERENCE, true),

  c("aider:start", "aider", "aider", "launch", "Start an Aider chat session.", AIDER_OPTIONS_REFERENCE),
  c("aider:model", "aider --model sonnet", "aider", "model", "Start Aider with a model alias.", AIDER_OPTIONS_REFERENCE),
  c("aider:architect", "aider --architect", "aider", "workflow", "Start Aider in architect/editor workflow mode.", AIDER_OPTIONS_REFERENCE),
  c("aider:message", 'aider --message "review this diff"', "aider", "headless", "Send a one-shot message to Aider.", AIDER_OPTIONS_REFERENCE),
  c("aider:yes", 'aider --yes --message "fix lint errors"', "aider", "permission", "Run Aider with automatic yes for prompts.", AIDER_OPTIONS_REFERENCE),
  c("aider:no-auto-commit", "aider --no-auto-commits", "aider", "git", "Disable Aider automatic commits.", AIDER_OPTIONS_REFERENCE),
  c("aider:watch", "aider --watch-files", "aider", "workflow", "Watch files for changes.", AIDER_OPTIONS_REFERENCE),
  c("aider:edit-format", "aider --edit-format diff", "aider", "config", "Choose Aider edit format.", AIDER_OPTIONS_REFERENCE),
  c("aider:api-key", "aider --api-key openai=<key>", "aider", "auth", "Set provider API key for the process.", AIDER_OPTIONS_REFERENCE),
  c("aider:slash-help", "/help", "aider", "diagnostic", "Show Aider in-chat command help.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-ask", "/ask ", "aider", "workflow", "Ask a question without editing files.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-code", "/code ", "aider", "workflow", "Ask Aider to edit code.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-add", "/add ", "aider", "context", "Add files to the chat context.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-drop", "/drop ", "aider", "context", "Remove files from the chat context.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-read-only", "/read-only ", "aider", "context", "Add files as read-only context.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-ls", "/ls", "aider", "context", "List files in the chat context.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-diff", "/diff", "aider", "git", "Show changes made by Aider.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-commit", "/commit", "aider", "git", "Commit changes from inside Aider.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-run", "/run ", "aider", "workflow", "Run a shell command and share output.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-test", "/test", "aider", "workflow", "Run the configured test command.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-tokens", "/tokens", "aider", "context", "Show token usage for context.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-model", "/model ", "aider", "model", "Switch Aider model.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-clear", "/clear", "aider", "session", "Clear the chat history.", AIDER_COMMANDS_REFERENCE, true),
  c("aider:slash-reset", "/reset", "aider", "session", "Drop all files and clear history.", AIDER_COMMANDS_REFERENCE, true),

  c("opencode:start", "opencode", "opencode", "launch", "Start the OpenCode TUI.", OPENCODE_CLI_REFERENCE),
  c("opencode:run", "opencode run Explain the use of context in Go", "opencode", "headless", "Run OpenCode in non-interactive mode.", OPENCODE_CLI_REFERENCE),
  c("opencode:run-model", 'opencode run --model anthropic/claude-sonnet-4-5 "review this diff"', "opencode", "model", "Run OpenCode with an explicit provider/model.", OPENCODE_CLI_REFERENCE),
  c("opencode:run-json", 'opencode run --format json "summarize this repo"', "opencode", "headless", "Run OpenCode and emit raw JSON events.", OPENCODE_CLI_REFERENCE),
  c("opencode:run-attach", 'opencode run --attach http://localhost:4096 "Explain async/await in JavaScript"', "opencode", "headless", "Attach a run to a running OpenCode server.", OPENCODE_CLI_REFERENCE),
  c("opencode:serve", "opencode serve", "opencode", "workflow", "Start a headless OpenCode server.", OPENCODE_CLI_REFERENCE),
  c("opencode:models", "opencode models", "opencode", "model", "List available OpenCode models.", OPENCODE_CLI_REFERENCE),
  c("opencode:models-provider", "opencode models anthropic", "opencode", "model", "List models for one provider.", OPENCODE_CLI_REFERENCE),
  c("opencode:models-refresh", "opencode models --refresh", "opencode", "model", "Refresh the cached model list.", OPENCODE_CLI_REFERENCE),
  c("opencode:auth-login", "opencode auth login", "opencode", "auth", "Authenticate a provider account.", OPENCODE_CLI_REFERENCE),
  c("opencode:auth-list", "opencode auth list", "opencode", "auth", "List authenticated providers.", OPENCODE_CLI_REFERENCE),
  c("opencode:github-install", "opencode github install", "opencode", "git", "Set up OpenCode GitHub Actions integration.", OPENCODE_CLI_REFERENCE),
  c("opencode:github-run", "opencode github run", "opencode", "git", "Run the GitHub agent.", OPENCODE_CLI_REFERENCE),
  c("opencode:mcp-add", "opencode mcp add", "opencode", "mcp", "Add an MCP server interactively.", OPENCODE_CLI_REFERENCE),
  c("opencode:mcp-list", "opencode mcp list", "opencode", "mcp", "List configured MCP servers.", OPENCODE_CLI_REFERENCE),
  c("opencode:mcp-auth", "opencode mcp auth <name>", "opencode", "mcp", "Authenticate an OAuth-enabled MCP server.", OPENCODE_CLI_REFERENCE),
  c("opencode:mcp-auth-list", "opencode mcp auth list", "opencode", "mcp", "List OAuth-capable MCP server auth status.", OPENCODE_CLI_REFERENCE),
  c("opencode:mcp-logout", "opencode mcp logout <name>", "opencode", "mcp", "Remove MCP OAuth credentials.", OPENCODE_CLI_REFERENCE),
  c("opencode:mcp-debug", "opencode mcp debug <name>", "opencode", "mcp", "Debug MCP OAuth connection issues.", OPENCODE_CLI_REFERENCE),
  c("opencode:slash-help", "/help", "opencode", "diagnostic", "Show OpenCode TUI command help.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-compact", "/compact", "opencode", "context", "Compact OpenCode conversation context.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-init", "/init", "opencode", "config", "Initialize project guidance for OpenCode.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-models", "/models", "opencode", "model", "Open model picker.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-new", "/new", "opencode", "session", "Start a new OpenCode session.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-redo", "/redo", "opencode", "session", "Redo a previously undone message.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-sessions", "/sessions", "opencode", "session", "Open session list.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-share", "/share", "opencode", "session", "Share the current session.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-themes", "/themes", "opencode", "config", "Open theme picker.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-thinking", "/thinking", "opencode", "config", "Toggle thinking block display.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-undo", "/undo", "opencode", "session", "Undo the previous message.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:slash-unshare", "/unshare", "opencode", "session", "Unshare the current session.", OPENCODE_TUI_REFERENCE, true),
  c("opencode:bash", "!git status", "opencode", "git", "Run a shell command from the OpenCode TUI.", OPENCODE_TUI_REFERENCE, true),

  c("copilot:start", "copilot", "github-copilot", "launch", "Start GitHub Copilot CLI.", COPILOT_CLI_REFERENCE),
  c("copilot:ask", 'copilot "explain this repository"', "github-copilot", "headless", "Ask Copilot CLI a prompt.", COPILOT_CLI_REFERENCE),
  c("copilot:allow-all", 'copilot --allow-all "fix failing tests"', "github-copilot", "permission", "Allow all Copilot CLI tool permissions.", COPILOT_CLI_REFERENCE),
  c("copilot:allow-tool", 'copilot --allow-tool="shell(git:*)" "inspect repository status"', "github-copilot", "permission", "Allow selected tool permission patterns.", COPILOT_CLI_REFERENCE),
  c("copilot:deny-tool", 'copilot --allow-tool="shell(git:*)" --deny-tool="shell(git push)" "prepare release notes"', "github-copilot", "permission", "Allow a class of tools while denying a risky command.", COPILOT_CLI_REFERENCE),
  c("copilot:mcp-tool", 'copilot --allow-tool="MyMCP(create_issue)" "file a tracking issue"', "github-copilot", "mcp", "Allow a specific MCP server tool.", COPILOT_CLI_REFERENCE),
  c("gh-copilot:suggest", "gh copilot suggest", "github-copilot", "headless", "Suggest a shell command with the GitHub CLI Copilot extension.", COPILOT_CLI_REFERENCE),
  c("gh-copilot:explain", "gh copilot explain", "github-copilot", "headless", "Explain a shell command with the GitHub CLI Copilot extension.", COPILOT_CLI_REFERENCE),
  c("gh-copilot:config", "gh copilot config", "github-copilot", "config", "Configure the GitHub CLI Copilot extension.", COPILOT_CLI_REFERENCE),
];
