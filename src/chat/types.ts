/**
 * The chat view's event model (main → page).
 * electron/chatItems.cjs and electron/chatLens.cjs carry the same shapes as
 * JSDoc @typedefs; tests/chat-items.test.ts checks real outputs against these
 * field lists.
 */

/** One item of a conversation. `order` sorts them: a main-transcript line's byte offset; LIVE_BASE + n for
 *  hook-only items not yet in the transcript; LIVE_ORDER for the provisional bubble. A sub-agent's items carry
 *  `parent` (the Agent tool row's id) and their own file's offsets. The page ignores kinds it does not know. */
export const LIVE_BASE = 2 ** 52
export const LIVE_ORDER = Number.MAX_SAFE_INTEGER
export interface ItemBase { id: string; order: number; at: number | null; parent?: string }
export interface UserItem extends ItemBase {
  kind: 'user'; text: string; images: number; truncated?: boolean
  /**
   * A message not yet seen in the transcript: this composer's bubble (with `local`), or — 'sent', no `local` — the
   * prompt main shows from its UserPromptSubmit until its line is written (electron/chatLens.cjs showPrompt)
   */
  pending?: 'sending' | 'sent' | 'unconfirmed'; local?: string   // the outbox entry it stands for
}
/** The provisional bubbles' orders: after every transcript line, before the new turn's hook rows */
export const PENDING_BASE = LIVE_BASE - 2 ** 32
export interface TextItem extends ItemBase { kind: 'text'; text: string; partial?: boolean; truncated?: boolean }
export type ToolState = 'running' | 'done' | 'failed' | 'rejected' | 'interrupted' | 'unknown'
export interface ToolItem extends ItemBase {
  kind: 'tool'; tool: string | null; input: ToolInput; state: ToolState
  waiting?: 'permission' | 'question' | 'plan'          // answered in the terminal in this phase
  output?: ToolOutput; diff?: DiffBlock; durationMs?: number
  agentId?: string; agentTools?: number                  // Agent/Task rows: the sub-agent and its tool count so far
}
export interface ToolInput {   // a whitelisted, capped excerpt — never the whole input
  file?: string; command?: string; description?: string; pattern?: string; path?: string; url?: string
  query?: string; question?: string; options?: string[]; plan?: string; todos?: { done: number; total: number }
  agentType?: string; background?: true                 // Agent / Task: run_in_background
  server?: string; mcpTool?: string
  files?: string[]                                       // SendUserFile: the files it sent (paths)
}
export interface ToolOutput { text: string; lines: number; truncated: boolean; error: boolean }
/** `truncated`: a line or the block's text was cut (a minified file, a long line); the counts are still whole */
export interface DiffBlock { file: string; kind: 'edit' | 'create' | 'write'; added: number; removed: number; hunks: DiffHunk[]; hidden: number; truncated?: boolean
  /** (a permission card's Edit) a newline added or taken at the very end, which no line shows */
  eol?: 'added' | 'removed' }
export interface DiffHunk { oldStart: number; newStart: number; lines: DiffLine[] }
export interface DiffLine { t: '+' | '-' | ' '; old: number | null; new: number | null; text: string }
/** `prompt-blocked`: another plugin's prompt hook blocked a prompt (`by`: that plugin; `text`: the prompt, when it read cleanly) */
export interface NoticeItem extends ItemBase { kind: 'notice'; notice: 'interrupted' | 'command' | 'compact' | 'summary' | 'agent-done' | 'unknown-block' | 'model' | 'prompt-blocked'; text?: string; by?: string }
export interface TurnEndItem extends ItemBase { kind: 'turn-end'; durationMs: number }
export interface LiveItem extends ItemBase { kind: 'live'; text: string }
/** A thinking block (shown from 생각 포함). Claude Code 2.1.32x writes its text empty (FINDINGS §1): `text` is ''
 *  then, and the row says the content is not in the record; `durationMs` from the line's thinkingDurationMs. */
/** update: a progress note (thinkingDisplay "updates"), shown in 기본 as prose; else hidden thinking, shown from 생각 포함 */
export interface ThinkingItem extends ItemBase { kind: 'thinking'; text: string; durationMs?: number; redacted?: boolean; truncated?: boolean; update?: true }
/** A `!` command (Claude Code's bash mode): running until its output line comes */
export interface ShellItem extends ItemBase { kind: 'shell'; command: string; state: 'running' | 'done'; stdout?: string; stderr?: string; truncated?: boolean }
export type ChatItem = UserItem | TextItem | ToolItem | NoticeItem | TurnEndItem | LiveItem | ThinkingItem | ShellItem

export type BannerReason = 'schema' | 'canary' | 'missing' | 'stalled' | 'rewrite' | 'version' | 'mapping' | 'worker'
  | 'unarmed'                          // (the page's own, when chat.open says the session is not armed: main never sends it)
export interface LensStatus {
  state: 'starting' | 'idle' | 'working' | 'waiting' | 'ended'
  since: number | null                 // working / waiting since (ms epoch)
  label: 'compact' | null              // what the work is, when known
  banner: { reason: BannerReason; detail?: string } | null
  note: 'new-version' | null           // a Claude Code newer than the verified range
  version: string | null
  hasOlder: boolean                    // older items exist before the first one sent
  empty: boolean                       // no transcript yet (a new session)
  waitingAgent?: string                // waiting on a sub-agent's permission: that sub-agent's id (absent: the main thread's own)
  queued?: QueuedPrompt[]              // what Claude Code queued, oldest first (at most 3 sent; absent when none)
  queuedCount?: number                 // all of them
  mode?: PermissionMode | null         // the permission mode the hooks last reported (null: one not known; absent: none yet)
  asks?: AskCard[]                     // what waits on the user, oldest first (absent when none)
  changes?: ChangeSummary              // the conversation's file changes (absent: no index for this view)
  agents?: RunningAgent[]              // the sub-agents at work now, oldest first (absent when none; electron/chatLens.cjs syncAgents)
}

/** A sub-agent at work (from the hooks: SubagentStart to SubagentStop, a background one until its wake-up) */
export interface RunningAgent {
  id: string                           // the agent id (Agent rows' agentId)
  since: number                        // its start (ms epoch)
  tools: number                        // tool calls so far
  toolId?: string                      // its Agent / Task call (the row), when known
  type?: string                        // subagent_type
  description?: string                 // what it was asked (its call's description)
  background?: boolean                 // run_in_background (absent: not known)
  last?: { tool: string; input: ToolInput }   // its latest tool call
}

// ---- the changes panel: electron/chatChanges.cjs mirrors these in JSDoc

/** The conversation's file changes as the worker's index has them (status.changes; `v` grows with every change) */
export interface ChangeSummary {
  v: number
  state: 'scanning' | 'ready' | 'partial' | 'gone'   // partial: the scan stopped at a cap; gone: the transcript went
  files: number; edits: number
  added: number; removed: number                      // sums over the edits whose counts are known
  unknown: number                                     // edits whose patch the record does not hold
}
export interface ChangeFile {
  file: string                 // relative to the session folder with forward slashes, else as recorded
  outside: boolean             // not inside the session folder
  created: boolean             // its first known edit made it (Write create)
  edits: number; added: number; removed: number; unknown: number
  cut: boolean                 // an edit was cut by a cap (counts still whole)
  agent: boolean               // a sub-agent made at least one of its edits
  last: number                 // the order of its latest edit (sorting, "recent first")
}
export interface ChangeEdit {
  toolId: string; order: number; at: number | null
  agentId?: string                                    // a sub-agent's edit
  kind: 'edit' | 'create' | 'write' | 'notebook'
  added: number | null; removed: number | null        // null: the record holds no patch for it
  state: 'ok' | 'missing' | 'stale'                   // stale: the line at its offset is not what was indexed
  diff?: DiffBlock                                    // only in chat:change-file answers, rebuilt from the transcript line
}

// ---- link previews: electron/linkFetch.cjs mirrors this in JSDoc

/** A link preview card, fetched by the chat worker under the preview policy (opt-in; every failure is silent) */
export interface LinkCardData {
  url: string                  // the link as written (what a click opens)
  site: string                 // the link's own host, always (Unicode, punycode beside when not ASCII); never og:site_name
                               // (what a page claims): a card never names another site. The page checks it (preview.ts hostLine)
  via: string | null           // the final host when a redirect left the link's host
  title: string; description: string
  image: { bytes: Uint8Array; type: 'png' | 'jpeg' | 'webp'; width: number; height: number } | null
}

/**
 * Something the session waits on the user for (electron/chatLens.cjs). `holdId` null: it can only be
 * answered in the terminal. The card shows what Claude Code asks, whole (`cut`: it could not be shown whole, so
 * it is answered in the terminal), and its `state` is the hold's as main tells it — never what was clicked.
 */
export interface AskCard {
  key: string                                   // stable: the hold id, else 'ask:' + the hold id
  holdId: string | null
  kind: 'permission' | 'question' | 'plan'
  toolId: string | null                         // the paired tool row, when known
  agent: boolean                                // a sub-agent's request
  tool: string                                  // the tool's name as Claude Code gave it
  input: ToolInput                              // Bash / PowerShell: the whole command; Edit / Write: the file; WebFetch: the URL; a plan: its text
  args?: string                                 // any other tool: its whole input as JSON
  diff?: DiffBlock                              // Edit / Write: what would change (whole)
  replaceAll?: boolean                          // an Edit that replaces every occurrence
  overwrite?: boolean                           // a Write over a file that is there (it replaces the file's contents)
  cwd?: string                                  // Bash / PowerShell: the folder the command runs in
  sandboxOff?: boolean                          // Bash / PowerShell: runs outside the sandbox (dangerouslyDisableSandbox)
  background?: boolean                          // Bash / PowerShell: runs in the background
  timeoutMs?: number                            // Bash / PowerShell: its own time limit
  fetchPrompt?: string                          // WebFetch: what is asked of the page
  always: { rule: string } | null               // 항상 허용 offered: the rule it adds for this session
  question?: { text: string; header?: string; options: { label: string; description?: string }[] }
  /** several questions, or a multi-select one: every question, the first as `question` too */
  questions?: { text: string; header?: string; multiSelect?: true; options: { label: string; description?: string }[] }[]
  state: 'open' | 'sent' | 'timeout' | 'terminal'
  sent?: 'allow' | 'always' | 'deny' | 'option' | 'options'
  cut?: boolean
  /** why it is answered in the terminal: too long to show whole, a field the card does not show, not sure the file is new */
  cutWhy?: 'long' | 'fields' | 'unsure'
  since: number
}
export type AnswerChoice = 'allow' | 'always' | 'deny' | 'option' | 'options'
export type AnswerRefusal = 'gone' | 'not-bound' | 'other-session' | 'hidden' | 'invalid' | 'not-answerable' | 'off'
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions' | 'dontAsk'
export interface QueuedPrompt { text: string; truncated: boolean }
export type ChatOp =
  | { op: 'reset'; items: ChatItem[]; status: LensStatus }
  | { op: 'upsert'; items: ChatItem[] }     // insert or replace by id (a later field set wins whole)
  | { op: 'remove'; ids: string[] }
  | { op: 'status'; status: LensStatus }
export interface ChatUpdate { id: string /* terminal id */; rev: number; ops: ChatOp[] }

// ---- the composer: the send's two calls (electron/chatHost.cjs, electron/chatInput.cjs)

/** The page's reading of the terminal's prompt row (src/chat/promptRow.ts) */
/**
 * What the page read on the prompt row. `suggestion` / `typed` (1.6.2): text whose dim marks were read, all dim (a
 * placeholder or a greyed suggestion) or not; `text`: text whose marks could not be read (the ledger decides)
 */
export type ScreenVerdict = 'empty' | 'suggestion' | 'typed' | 'text' | 'unknown'
/** What the echo of a send must show before Enter (chatInput.cjs encodeSend) */
export interface Expect { head: string; images: number; long: boolean }
/** What the page saw of the echo when it asks for Enter */
export type EchoVerdict = 'ok' | 'mismatch' | 'blocked' | 'timeout'
export type SendRefusal = 'off' | 'no-session' | 'not-claude' | 'unarmed' | 'duplicate' | 'sending' | 'waiting' | 'screen' | 'prompt-busy' | 'prompt-unknown' | 'empty' | 'too-long' | 'images'
export type SubmitRefusal = 'not-in-flight' | 'no-echo' | 'waiting' | 'no-session'
export type InterruptRefusal = 'not-working' | 'waiting' | 'sending' | 'debounced' | 'no-session'
export type ImageRefusal = 'type' | 'size' | 'limit' | 'off' | 'io'
/** chat:redraw (electron/chatHost.cjs redraw): why no resize nudge was made */
export type RedrawRefusal = 'off' | 'no-session' | 'unarmed' | 'not-shown' | 'sending' | 'waiting' | 'recent'
