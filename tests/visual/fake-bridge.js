/*
 * fake-bridge.js — a stand-in for the desktop bridge (electron/preload.cjs →
 * window.spawn, typed as spawnBridge in src/desktop.ts), injected by
 * tests/visual/shots.mjs with page.addInitScript before the app's code runs.
 *
 * It reads window.__SHOT__ = { mode, workMode, terminals, board, branches,
 * history, transcript, shellTranscript, version, update, chat, chatAgent } (set by an earlier init script) and
 * answers every bridge call from it. Nothing touches the network or a disk; no
 * pty. Calls that would change something (terminals.move / close / rename /
 * create / send / write / resize) do nothing but are recorded, in order, in
 * window.__CALLS__ as { fn, args } so a harness flow can assert on them.
 */
(() => {
  const shot = window.__SHOT__ || {}
  const calls = (window.__CALLS__ = [])
  const record = (fn, args) => { calls.push({ fn, args: JSON.parse(JSON.stringify(args)) }) }
  const ok = (extra) => Promise.resolve(Object.assign({ ok: true }, extra || {}))
  const noop = () => {}
  const off = () => noop

  // DEFAULT_SETTINGS in src/settingsStore.ts, with 업무 모드 from the shot and shot.settings laid over it
  // (e.g. { session: { chatView: true, linkPreviews: true } } for the link preview cards)
  let settings = {
    notify: { catch: true, flee: true, evolve: true, levelup: true, rareOnly: false, duration: 'normal', quiet: false, quietFrom: '23:00', quietTo: '08:00', sound: true, sessions: true },
    privacy: { hidePrompts: false },
    session: { defaultCwd: '', model: '', permissionMode: '', confirmClose: true, restoreOnStart: true, tools: [], defaultTool: 'claude', chatView: false, linkPreviews: false, autoSort: false, manualOrderOn: true },
    app: { openAtLogin: false, startHidden: false, widgetOnTop: true, language: 'auto', workMode: !!shot.workMode },
    terminal: { scrollback: 5000, font: 'default' },
  }
  for (const k of Object.keys(shot.settings || {})) if (settings[k]) settings[k] = Object.assign({}, settings[k], shot.settings[k])
  const settingsListeners = new Set()

  // shot.restore: a start that reopens the last run's sessions (their terminals come back one by one, each a
  // moment after the page asks: restorable() names them, create({ resume }) brings each back, onList says so)
  const held = shot.restore ? (shot.terminals || []).map(t => Object.assign({}, t)) : []
  const terminals = shot.restore ? [] : (shot.terminals || []).map(t => Object.assign({}, t))
  const listListeners = new Set()
  let mode = shot.mode || 'window'
  const modeListeners = new Set()
  // shot.update: an update on offer (e.g. { status: 'available', latest: '9.9.9' }) for the header's button
  const update = Object.assign({ status: 'idle', current: shot.version || '0.0.0', latest: null, notes: '', progress: 0, error: null, needsFull: false, page: '' }, shot.update || {})
  // Terminal output after the replay, for a flow: window.__TERM_PUSH__(id, data) sends a batch
  // (numbered after the replay's seq 1, as main numbers them)
  const dataListeners = new Set()
  const seqOf = {}
  window.__TERM_PUSH__ = (id, data) => { seqOf[id] = (seqOf[id] || 1) + 1; dataListeners.forEach(fn => fn({ id, data, seq: seqOf[id] })) }

  // The chat view (shot.chat: terminal id -> the reset chat.open answers with, from chatFixture.mjs;
  // shot.chatAgent: Agent row id -> its sub-agent's items). Updates go out on a later tick, as
  // main's would. window.__CHAT_PUSH__(id, ops) sends the next rev (a flow's own update). The
  // calls are recorded as chat.open / chat.close / chat.older / chat.reload / chat.resync / chat.agent.
  const chatListeners = new Set()
  const chatRev = {}
  const chatSend = (u) => { setTimeout(() => chatListeners.forEach(fn => fn(JSON.parse(JSON.stringify(u)))), 0) }
  window.__CHAT_PUSH__ = (id, ops) => { chatRev[id] = (chatRev[id] || 0) + 1; chatSend({ id, rev: chatRev[id], ops }) }
  // shot.chatOpts: { openFails } open answers { ok: false } (no reader; a string: with that reason, e.g. 'unarmed');
  // { olderFails } older answers { ok: false };
  // { silent } open answers ok and sends nothing (a reset that never comes)
  const chatOpts = shot.chatOpts || {}

  // The composer: chat.send / submit / interrupt / image / dropImage / files are
  // recorded (an image as its size and first bytes) and answered from window.__CHAT_SCRIPT__ (a value,
  // or a function of the call's argument), else as main would answer a send that goes through. The
  // fake screen: window.__SCREEN__(termId, name) writes a fixture screen (shot.screens, from
  // tests/fixtures/chat/screens) into that terminal's real xterm, sized to its columns as Claude Code
  // draws: the rules as wide as the terminal, long lines wrapped with a two-space indent.
  const script = (name, arg, fallback) => {
    const s = (window.__CHAT_SCRIPT__ || {})[name]
    const v = typeof s === 'function' ? s(arg) : s
    if (v === 'hang') return new Promise(() => {})
    return Promise.resolve(JSON.parse(JSON.stringify(v === undefined ? fallback : v)))
  }
  const headOf = (text) => {
    const t = String(text || '')
    const lead = /^[!#@]/.test(t) || (/^\//.test(t) && !/^\/[A-Za-z][\w:.-]{0,63}(?:[ \t]|$)/.test(t)) ? ' ' : ''
    return Array.from((lead + t).split('\n')[0].replace(/\s+/g, ' ').trim()).slice(0, 24).join('').trimEnd()
  }
  const sizes = {}
  window.__SCREEN__ = (id, name) => {
    const text = (shot.screens || {})[name]
    if (typeof text !== 'string') throw new Error(`no screen ${name}`)
    // (a terminal never fitted, hidden under the chat from the start, has xterm's own 80 columns)
    const cols = (sizes[id] && sizes[id].cols) || 80
    const out = []
    for (const line of text.replace(/\n$/, '').split('\n')) {
      if (/^\s*[─╌]{20,}\s*$/.test(line)) { const ch = line.trim()[0]; const lead = line.match(/^\s*/)[0]; out.push(lead + ch.repeat(Math.max(20, cols - lead.length))); continue }
      let rest = Array.from(line)
      while (rest.length > cols) { out.push(rest.slice(0, cols).join('')); rest = Array.from('  ').concat(rest.slice(cols)) }
      out.push(rest.join(''))
    }
    window.__TERM_PUSH__(id, '\x1b[2J\x1b[3J\x1b[H' + out.join('\r\n'))
  }

  window.spawn = {
    isDesktop: true,
    // main's chat view switch, as the preload passes it (src/features.ts follows it): on when the shot
    // has a conversation or a session carrying the chat key, off otherwise (the 1.4.0 surfaces)
    features: { chatView: !!shot.chat || terminals.some(t => t.chat !== undefined) },
    chat: {
      // a picture the conversation names: drawn here (a missing one, 'gone', cannot be read)
      // a picture the user sent, read again from its message (drawn here: the message and its place)
      userImage: (id, itemId, index) => {
        record('chat.userImage', [id, itemId, index])
        const c = new OffscreenCanvas(1600, 1000)
        const g = c.getContext('2d')
        g.fillStyle = index ? '#24344d' : '#3a2433'; g.fillRect(0, 0, 1600, 1000)
        g.fillStyle = '#d7dae3'; g.font = '72px sans-serif'; g.fillText(`sent picture ${index + 1}`, 96, 320)
        return c.convertToBlob({ type: 'image/png' }).then(b => b.arrayBuffer()).then(buf => ({ ok: true, type: 'image/png', bytes: new Uint8Array(buf) }))
      },
      localImage: (id, path) => {
        record('chat.localImage', [id, path])
        if (/gone/.test(path)) return Promise.resolve({ ok: false, reason: 'missing' })
        const c = new OffscreenCanvas(1600, 1000)
        const g = c.getContext('2d')
        const hue = [...path].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360
        g.fillStyle = `hsl(${hue} 30% 16%)`; g.fillRect(0, 0, 1600, 1000)
        g.fillStyle = `hsl(${hue} 60% 70%)`; g.fillRect(80, 80, 1440, 120)
        g.fillStyle = '#d7dae3'; g.font = '64px sans-serif'; g.fillText(path.split(/[\/]/).pop(), 96, 320)
        return c.convertToBlob({ type: 'image/png' }).then(b => b.arrayBuffer()).then(buf => ({ ok: true, type: 'image/png', bytes: new Uint8Array(buf) }))
      },
      open: (id) => {
        record('chat.open', [id])
        if (chatOpts.openFails) return Promise.resolve(typeof chatOpts.openFails === 'string' ? { ok: false, reason: chatOpts.openFails } : { ok: false })
        const u = (shot.chat || {})[id]
        if (u && !chatOpts.silent) { chatRev[id] = u.rev; chatSend(u) }
        return ok()
      },
      close: (id) => record('chat.close', [id]),
      older: (id) => { record('chat.older', [id]); return chatOpts.olderFails ? Promise.resolve({ ok: false, loaded: 0 }) : ok({ loaded: 0 }) },
      reload: (id) => { record('chat.reload', [id]); return ok() },
      // a lost update: the conversation again as it was opened (a reset with the next rev)
      resync: (id) => {
        record('chat.resync', [id])
        const u = (shot.chat || {})[id]
        if (u) { chatRev[id] = (chatRev[id] || 0) + 1; chatSend(Object.assign({}, u, { rev: chatRev[id] })) }
        return ok()
      },
      agent: (id, toolId) => {
        record('chat.agent', [id, toolId])
        const items = (shot.chatAgent || {})[toolId]
        if (items) window.__CHAT_PUSH__(id, [{ op: 'upsert', items }])
        return ok()
      },
      onUpdate: (fn) => { chatListeners.add(fn); return () => chatListeners.delete(fn) },
      send: (p) => {
        record('chat.send', [p])
        const command = /^\/[A-Za-z][\w:.-]{0,63}(?:[ \t]|$)/.test(p.text) && !/[\n\t]/.test(p.text) && !p.images.length
        return script('send', p, { ok: true, expect: { head: command ? p.text : headOf(p.text), images: p.images.length, long: /\n/.test(p.text) || p.text.length > 200 }, command, minEnterMs: 150 + 250 * p.images.length })
      },
      // (as main: Enter only for an echo seen; 'hang' in the script: an answer that never comes)
      submit: (p) => { record('chat.submit', [p]); return script('submit', p, p.echo === 'ok' ? { ok: true } : { ok: false, reason: 'no-echo' }) },
      interrupt: (id) => { record('chat.interrupt', [id]); return script('interrupt', id, { ok: true }) },
      // the dialog card's keys (chat-question-flip): only with shot.chatOpts.dialogKey, so no other flow
      // starts reading its screens for a dialog; an arrow moves the fixture screen's mark as Claude Code would
      ...(chatOpts.dialogKey ? {
        dialogKey: (p) => {
          record('chat.dialogKey', [p])
          if (typeof window.__DIALOG_KEY__ === 'function') window.__DIALOG_KEY__(p)
          return script('dialogKey', p, { ok: true })
        },
      } : {}),
      image: (p) => {
        const b = p.bytes || new Uint8Array(0)
        record('chat.image', [{ id: p.id, size: b.length, head: Array.from(b.slice(0, 8)) }])
        const token = Array.from({ length: 24 }, (_, i) => '0123456789abcdef'[(calls.length * 7 + i * 5) % 16]).join('')
        return script('image', p, { ok: true, token, type: 'png' })
      },
      dropImage: (p) => record('chat.dropImage', [p]),
      files: (p) => { record('chat.files', [p]); return script('files', p, { ok: true, files: ['src/lib/safe-redirect.ts', 'src/middleware.ts', 'README.md'].filter(f => f.toLowerCase().includes(String(p.query || '').toLowerCase())) }) },
      stranded: (id) => { record('chat.stranded', [id]); return script('stranded', id, { stranded: false }) },
      // the buttons: which chat is shown, and an answer card's choice (answered from the script, else ok)
      visible: (id, on) => record('chat.visible', on === false ? [id, false] : [id]),
      answer: (p) => { record('chat.answer', [p]); return script('answer', p, { ok: true }) },
      // the redraw nudge for a shown chat's hidden terminal (recorded; answered from the script, else ok)
      redraw: (id) => { record('chat.redraw', [id]); return script('redraw', id, { ok: true }) },
      // the 변경 사항 panel: shot.changes[id] = { list, pages } from chatFixture.mjs changes() (the real
      // electron/chatChanges.cjs over changes.jsonl); recorded, answered from the script first, else from the shot
      changes: (id) => {
        record('chat.changes', [id])
        const c = (shot.changes || {})[id]
        return script('changes', id, c ? Object.assign({ ok: true }, c.list) : { ok: false })
      },
      // link previews: recorded; answered from the script first, else shot.previews[url] (a card whose image
      // bytes are a plain array of numbers in the shot, handed on as a Uint8Array as main does), else shot.previewAll
      // (a made-up card for any https://*.example/ link: a long session's flow), else { ok: false }
      preview: (p) => {
        record('chat.preview', [p])
        const url = String((p && p.url) || '')
        const made = (shot.previews || {})[url] || (shot.previewAll && /^https:\/\/[a-z0-9.-]+\.example\//.test(url)
          ? { url, site: new URL(url).hostname, via: null, title: `Notes ${url.split('/').pop()}`, description: 'A page about rivers.', image: null } : null)
        return script('preview', p, made ? { ok: true, card: made } : { ok: false }).then(r => {
          if (r && r.ok && r.card && r.card.image && Array.isArray(r.card.image.bytes)) r.card.image.bytes = Uint8Array.from(r.card.image.bytes)
          return r
        })
      },
      changeFile: (p) => {
        record('chat.changeFile', [p])
        const c = (shot.changes || {})[p && p.id]
        const page = c && c.pages[String((p && p.file) || '').replace(/\\/g, '/').toLowerCase()]
        if (!page) return script('changeFile', p, c ? { ok: false, reason: 'unknown' } : { ok: false, reason: 'gone' })
        // (before: the edits older than that order, as the lens pages them; the fixture's files have at most 4)
        const edits = typeof p.before === 'number' ? page.edits.filter(e => e.order < p.before) : page.edits
        return script('changeFile', p, Object.assign({ ok: true }, page, { edits, more: typeof p.before === 'number' ? 0 : page.more }))
      },
    },
    terminals: {
      list: () => Promise.resolve(terminals.map(t => Object.assign({}, t))),
      create: (opts) => {
        record('create', [opts])
        // (a shell tab comes back as a fresh shell in its folder: the held one of that folder not back yet)
        const back = !shot.restore || !opts ? null : opts.resume ? held.find(t => t.sessionId === opts.resume) : opts.tool === 'shell' ? held.find(t => t.tool === 'shell' && t.cwd === opts.cwd && !terminals.some(x => x.id === t.id)) : null
        if (!back) return Promise.resolve({ error: 'harness: no pty' })
        return new Promise(res => setTimeout(() => {
          terminals.push(Object.assign({}, back))
          const list = terminals.map(t => Object.assign({}, t))
          listListeners.forEach(fn => fn(list))
          res({ id: back.id, sessionId: back.sessionId })
        }, 150))
      },
      pickFolder: () => Promise.resolve(null),
      restorable: () => Promise.resolve(shot.restore ? held.map(t => ({ sessionId: t.sessionId, cwd: t.cwd, tool: t.tool || 'claude' })) : []),
      branches: (dirs) => Promise.resolve(Object.fromEntries((dirs || []).map(d => [d, (shot.branches || {})[d] ?? null]))),
      history: () => Promise.resolve((shot.history || []).map(h => Object.assign({}, h))),
      buffer: (id) => {
        const t = terminals.find(x => x.id === id)
        return Promise.resolve({ data: (t && t.tool === 'shell' ? shot.shellTranscript : shot.transcript) || '', seq: 1 })
      },
      write: (id, data) => record('write', [id, data]),
      resize: (id, cols, rows) => { sizes[id] = { cols, rows }; record('resize', [id, cols, rows]) },
      send: (id, text) => { record('send', [id, text]); return ok() },
      close: (id) => { record('close', [id]); return Promise.resolve() },
      rename: (id, title) => { record('rename', [id, title]); return Promise.resolve(true) },
      move: (id, index) => { record('move', [id, index]); return Promise.resolve(true) },
      pathForFile: () => '',
      openUrl: () => Promise.resolve(),
      openPath: (...args) => { record('terminals.openPath', args); return Promise.resolve(false) },
      onData: (fn) => { dataListeners.add(fn); return () => dataListeners.delete(fn) },
      onList: (fn) => { listListeners.add(fn); return () => listListeners.delete(fn) },
    },
    cloud: {
      signIn: () => Promise.resolve({ ok: false, reason: 'harness' }),
      signOut: () => ok(),
      sync: () => Promise.resolve({ ok: false, reason: 'harness' }),
    },
    settings: {
      get: () => Promise.resolve(settings),
      set: (patch) => {
        const next = {}
        for (const k of Object.keys(settings)) next[k] = Object.assign({}, settings[k], (patch || {})[k] || {})
        settings = next
        settingsListeners.forEach(fn => fn(settings))
        return Promise.resolve(settings)
      },
      onChange: (fn) => { settingsListeners.add(fn); return () => settingsListeners.delete(fn) },
      onOpen: off,
      workModeAtLoad: !!shot.workMode,
    },
    board: {
      get: () => ok({ rows: (shot.board || []).map(r => Object.assign({}, r)) }),
      profile: () => ok({ profile: null }),
      setProfile: () => Promise.resolve({ ok: false, reason: 'harness' }),
    },
    data: {
      exportBackup: () => Promise.resolve({ ok: false, reason: 'harness' }),
      openFolder: () => Promise.resolve(false),
    },
    env: {
      check: () => Promise.resolve({
        claude: { ok: true, version: '2.1.0', link: '' },
        git: { ok: true, version: '2.47.0', link: '' },
      }),
      openLink: () => Promise.resolve(),
    },
    toast: { show: noop, done: noop, ready: noop, open: noop, onEvent: off },
    game: {
      throw: () => Promise.resolve({ ok: false, reason: 'harness' }),
      release: () => Promise.resolve({ ok: false, reason: 'harness' }),
      exchange: () => Promise.resolve({ ok: false, reason: 'harness' }),
      arrange: ids => { window.__ARRANGED__ = ids; return ok() },
      swap: () => Promise.resolve({ ok: false, reason: 'harness' }),
    },
    update: {
      get: () => Promise.resolve(Object.assign({}, update)),
      install: () => Promise.resolve(Object.assign({}, update)),
      restart: () => Promise.resolve(false),
      onState: off,
    },
    feedback: {
      capture: () => Promise.resolve(null),
      send: () => Promise.resolve({ ok: false, reason: 'harness' }),
      copy: () => Promise.resolve({ ok: false, reason: 'harness' }),
    },
    widget: {
      hide: () => Promise.resolve(),
      getMode: () => Promise.resolve(mode),
      minimize: () => Promise.resolve(),
      setMode: (m) => { mode = m; modeListeners.forEach(fn => fn(m)); return Promise.resolve(m) },
      onMode: (fn) => { modeListeners.add(fn); return () => modeListeners.delete(fn) },
      onOpenDex: off,
      resize: noop,
      alert: noop,
    },
  }
})()
