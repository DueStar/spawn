/**
 * spawn-hook.cjs — Claude Code hook -> the spawn server.
 *
 * Claude Code passes the hook event as JSON on stdin. buildEvent turns it into
 * one server event (or nothing), which is POSTed, signed with the server
 * token, to http://127.0.0.1:3334/event (SPAWN_PORT / SPAWN_EVENT_URL move
 * it). The app's sessions get this hook through their --settings file
 * (electron/terminals.cjs), run by the app itself in Node mode.
 *
 * Hook events handled:
 *   PreToolUse         a tool call: a step for the session's Pokémon, and the
 *                      session's Claude seen working
 *   PostToolUse        a call finished: lowers the permission hand that very
 *                      call raised (main thread or subagent)
 *   PostToolUseFailure a tool call errored (a non-zero Bash exit lands here and
 *                      gets NO PostToolUse)
 *   SubagentStop       a subagent finished (lowers a hand it raised)
 *   SessionStart/End   the session began (startup/resume/compact/clear/fork) / exited
 *   UserPromptSubmit   the trainer's prompt (or a background task waking Claude)
 *   Stop               Claude's turn ended: its reply + the background work still running
 *   PermissionRequest  Claude is waiting for a permission answer
 *   Notification       permission_prompt / idle_prompt / quota_* / agent_needs_input
 *   StopFailure        the turn ended on an API error
 *   PreCompact/PostCompact  context compaction started / finished
 *   PostToolBatch      a batch of tool calls finished
 *   CwdChanged         the session cd'd somewhere else (the project tag follows)
 *   PostModelSwitch    the session runs another model now
 *
 * Every event carries the session it came from: sessionId (session_id),
 * project (the cwd's last folder), cwd and transcriptPath. buildEvent lives in
 * hook-event.cjs, shared with the server's http hook route (POST /hook/...):
 * a session the app launches now reports every event but SessionStart
 * through that route (no process started per event); this script still runs
 * on SessionStart (Claude Code runs only command hooks there; it also writes
 * the session-links file below) and, for every event, in sessions an older
 * release launched.
 *
 * Nothing is ever printed on stdout: on UserPromptSubmit it would be injected
 * into Claude's context, on PermissionRequest it would answer the dialog. The
 * exit code is always 0, and a stopped server costs at most the 1 s timeout.
 *
 * The payload shapes are the ones Claude Code 2.1.300 was observed sending
 * (tests/hook-script.test.ts holds verbatim captures).
 */

const { buildEvent, callKey, canonical, terminalSessionId } = require('./hook-event.cjs')

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** stdin -> event -> signed POST; always exits 0, prints nothing */
async function main() {
  // When the hook started: a tool-call hook runs in the background (async), so its event can
  // reach the server after a later one; the server tells by this time
  const startedAt = Date.now()
  const { readStdin, postJson, serverUrl } = require('./post.cjs')
  let event = null
  let d = null
  try { d = JSON.parse((await readStdin()) || '{}') } catch { /* not JSON: nothing to send */ }
  if (d) {
    event = buildEvent(d)
    // The conversation now going on in this app terminal (another one after /clear): what reopening it resumes
    const link = process.env.SPAWN_LINK_FILE
    if (link && isObj(d) && d.hook_event_name === 'SessionStart' && terminalSessionId() && /^[0-9a-f-]{36}$/i.test(String(d.session_id))) {
      // (a /clear: the conversation it leaves behind is noted in `<link>.prev`, so the resume list can fold it under
      // the one that follows, which Claude Code gives the same title; electron/history.cjs supersededIds)
      try {
        const fs = require('fs')
        if (d.source === 'clear') {
          let before = ''
          try { before = fs.readFileSync(link, 'utf8').trim() } catch { /* never cleared before: the terminal's own */ }
          if (!/^[0-9a-f-]{36}$/i.test(before)) before = terminalSessionId()
          if (before && before !== String(d.session_id) && before !== terminalSessionId()) fs.appendFileSync(`${link}.prev`, `${before}\n`)
        }
        fs.writeFileSync(link, String(d.session_id))
      } catch { /* not worth failing the hook */ }
    }
  }
  if (event) await postJson(serverUrl('event'), JSON.stringify({ ...event, at: startedAt }))
  process.exit(0)
}

if (require.main === module) main()

module.exports = { buildEvent, callKey, canonical, terminalSessionId }
