/**
 * The composer's / menu (2026-11-19, the owner's report: typing / showed no command menu). A draft that is one token
 * starting with / and the caret in it opens a menu of Claude Code's commands, filtered by the letters after the /
 * (a prefix of the name or of an alias). Picking one fills `/name ` and never sends. The list: Claude Code's own
 * commands (below, read from the 2.1.328 binary: name, aliases, its own one-line description), then the user's and
 * the project's commands and skills, and the enabled plugins' (main reads their front matter: electron/chatCommands.cjs).
 *
 * Also when the composer last sent a command to a terminal: a panel that opens right after one (/remote-control's has
 * no "Esc to cancel" line though Esc closes it) gets 취소 on its card.
 */

export type CommandKind = 'builtin' | 'user' | 'project' | 'skill' | 'plugin'
export interface SlashCommand { name: string; aliases?: string[]; desc: string; kind: CommandKind; hint?: string }

/**
 * Claude Code's own commands as 2.1.328 lists them (its hidden and removed ones left out). The descriptions are its
 * own words: a command's description is shown as Claude Code shows it, never translated.
 */
export const BUILTIN_COMMANDS: readonly SlashCommand[] = Object.freeze(([
  ['add-dir', [], 'Add a working directory'],
  ['branch', [], 'Create a branch of the current conversation at this point'],
  ['btw', [], 'Ask a side question without interrupting Claude'],
  ['clear', ['reset', 'new'], 'Start a new session with empty context; previous session stays on disk (resumable with /resume)'],
  ['color', [], 'Set the prompt bar color for this session'],
  ['compact', [], 'Free up context by summarizing the conversation so far'],
  ['config', ['settings'], 'Open settings'],
  ['context', [], 'Show what fills the context'],
  ['copy', [], 'Copy the last response to clipboard (/copy 2 for the one before)'],
  ['diff', [], 'View uncommitted changes and per-turn diffs'],
  ['doctor', ['checkup'], "Health-check the user's Claude Code setup and fix issues"],
  ['effort', [], "Set the model's effort level"],
  ['exit', ['quit'], 'Exit the CLI'],
  ['export', [], 'Export this session to a file or clipboard'],
  ['fast', [], 'Toggle fast mode'],
  ['bug', [], 'Report a bug or share your session'],
  ['feedback', [], 'Send feedback to Anthropic or report a bug'],
  ['fork', [], 'Start a background agent with the full conversation'],
  ['help', [], 'Show help and available commands'],
  ['hooks', [], 'View hook configurations for tool events'],
  ['ide', [], 'Manage IDE integrations and show status'],
  ['init', [], 'Initialize a new CLAUDE.md file with codebase documentation'],
  ['insights', [], 'Generate a report analyzing your Claude Code sessions'],
  ['keybindings', [], 'Open your keyboard shortcuts file'],
  ['login', [], 'Sign in with your Anthropic account'],
  ['logout', [], 'Sign out from your Anthropic account'],
  ['mcp', [], 'Manage MCP servers'],
  ['memory', [], 'Edit CLAUDE.md files and memory settings'],
  ['mobile', ['ios', 'android'], 'Show QR code to download the Claude mobile app'],
  ['model', [], 'Set the AI model for Claude Code'],
  ['output-style', [], 'List output styles or switch to one'],
  ['permissions', ['allowed-tools'], 'Manage allow and deny tool permission rules'],
  ['plan', [], 'Turn on plan mode or view the plan'],
  ['plugin', ['plugins', 'marketplace'], 'Manage Claude Code plugins'],
  ['recap', [], 'Generate a one-line session recap now'],
  ['release-notes', [], 'View release notes'],
  ['reload-plugins', [], 'Activate pending plugin changes in the current session'],
  ['reload-skills', [], 'Pick up skills added or changed on disk during this session'],
  ['remote-control', ['rc'], 'Control this session from your phone or claude.ai/code'],
  ['rename', ['name'], 'Rename the current conversation'],
  ['resume', [], 'Resume a previous session'],
  ['rewind', ['checkpoint', 'undo'], 'Restore the code and/or conversation to a previous point'],
  ['skills', [], 'List available skills'],
  ['status', [], 'Show version, account, model, MCP servers, and setup warnings'],
  ['tasks', ['bashes'], 'View and manage everything running in the background'],
  ['theme', [], 'Change the theme'],
  ['usage', ['cost', 'stats'], 'Show session cost, plan usage, and activity stats'],
  ['version', [], "Show this session's version (autoupdate may have a newer one)"],
] as const).map(([name, aliases, desc]) => Object.freeze({ name, aliases: [...aliases], desc, kind: 'builtin' as const })))

/** The / being typed: the draft is one token starting with / (no space before it, nothing after it) and the caret is in it */
export function slashAt(value: string, caret: number): { query: string } | null {
  if (!/^\/[^\s/]*$/.test(value) || caret < 1 || caret > value.length) return null
  return { query: value.slice(1) }
}

/**
 * The commands whose name or an alias starts with the query (any case): the name's own match first, then an alias's;
 * Claude Code's own before the rest at the same rank, then by name. A name seen twice keeps its first (Claude Code's
 * own wins over a file of the same name; the project's over the user's, as the lists come in that order).
 */
export function filterCommands(list: readonly SlashCommand[], query: string, max = 50): SlashCommand[] {
  const q = query.toLowerCase()
  const seen = new Set<string>()
  const scored: { c: SlashCommand; rank: number; at: number }[] = []
  list.forEach((c, at) => {
    const key = c.name.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    const rank = key === q ? 0 : key.startsWith(q) ? 1 : (c.aliases ?? []).some(a => a.toLowerCase().startsWith(q)) ? 2 : -1
    if (rank >= 0) scored.push({ c, rank, at })
  })
  const own = (c: SlashCommand) => (c.kind === 'builtin' ? 0 : 1)
  scored.sort((a, b) => a.rank - b.rank || (q ? own(a.c) - own(b.c) : 0) || (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : a.at - b.at))
  return scored.slice(0, max).map(s => s.c)
}

/** The built-ins, then what main read (project, user, skills, plugins: each checked again here) */
export function mergeCommands(read: unknown): SlashCommand[] {
  const out: SlashCommand[] = [...BUILTIN_COMMANDS]
  if (!Array.isArray(read)) return out
  for (const x of read.slice(0, 500)) {
    if (!x || typeof x !== 'object') continue
    const { name, desc, kind, hint } = x as Record<string, unknown>
    if (typeof name !== 'string' || !/^[A-Za-z0-9][\w:.-]{0,63}$/.test(name)) continue
    const k: CommandKind = kind === 'project' || kind === 'user' || kind === 'skill' || kind === 'plugin' ? kind : 'user'
    out.push({ name, desc: typeof desc === 'string' ? desc.slice(0, 300) : '', kind: k, ...(typeof hint === 'string' && hint ? { hint: hint.slice(0, 80) } : {}) })
  }
  return out
}

// ---- when the composer last sent a command to each terminal --------------------------------------------------------

const commandAt = new Map<string, number>()
/** A command went to terminal `id` at `at` (Date.now()) */
export function noteCommand(id: string, at: number) { commandAt.set(id, at) }
/** How long a panel without an Esc line counts as the command's own (its card offers 취소) */
export const COMMAND_PANEL_MS = 8000
/** Whether a command went to terminal `id` at most COMMAND_PANEL_MS before `now` */
export function commandRecent(id: string, now: number): boolean {
  const at = commandAt.get(id)
  return at !== undefined && now - at >= 0 && now - at <= COMMAND_PANEL_MS
}
