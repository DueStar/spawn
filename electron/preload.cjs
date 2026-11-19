'use strict'

// The page's only door to the app: a narrow API over IPC (contextIsolation +
// sandbox stay on, the page never gets Node). Exposed as window.spawn.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

function on(channel, fn) {
  const listener = (_event, payload) => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('spawn', {
  isDesktop: true,
  terminals: {
    list: () => ipcRenderer.invoke('terminals:list'),
    create: (opts) => ipcRenderer.invoke('terminals:create', opts ?? {}),
    pickFolder: () => ipcRenderer.invoke('terminals:pick-folder'),
    restorable: () => ipcRenderer.invoke('terminals:restorable'),
    branches: (dirs) => ipcRenderer.invoke('terminals:branches', dirs),
    history: () => ipcRenderer.invoke('sessions:history'),
    // the open / closing / running state of rows already listed (the picker asks again while one is running or closing)
    states: (ids) => ipcRenderer.invoke('sessions:states', Array.isArray(ids) ? ids.map(String) : []),
    // a session deleted from the resume list: into the trash for 7 days, and back (main checks it is not running)
    trash: (id) => ipcRenderer.invoke('sessions:trash', String(id)),
    restore: (id) => ipcRenderer.invoke('sessions:restore', String(id)),
    buffer: (id) => ipcRenderer.invoke('terminals:buffer', id),
    write: (id, data) => ipcRenderer.send('terminals:write', { id, data }),
    resize: (id, cols, rows) => ipcRenderer.send('terminals:resize', { id, cols, rows }),
    send: (id, text) => ipcRenderer.invoke('terminals:send', { id, text }),
    close: (id) => ipcRenderer.invoke('terminals:close', id),
    rename: (id, title) => ipcRenderer.invoke('terminals:rename', { id, title }),
    move: (id, index) => ipcRenderer.invoke('terminals:move', { id, index }),
    // A file dropped on a terminal: its path on disk (File.path is gone since Electron 32)
    pathForFile: (file) => { try { return webUtils.getPathForFile(file) || '' } catch { return '' } },
    // Ctrl+click on a link in a terminal: the user's browser opens it (http/https only)
    openUrl: (url) => ipcRenderer.invoke('terminals:open-url', String(url)),
    // (opts.from 'chat': a chat view's path chip — the editor or the folder, never the file run; a terminal's call is as it was)
    openPath: (id, file, line, col, opts) => ipcRenderer.invoke('terminals:open-path', opts && opts.from === 'chat' ? { id, file, line, col, from: 'chat' } : { id, file, line, col }),
    onData: (fn) => on('terminals:data', fn),
    onList: (fn) => on('terminals:list', fn),
  },
  // main's feature switches the page follows (asked once, synchronously, as workModeAtLoad is)
  features: {
    chatView: (() => { try { return ipcRenderer.sendSync('features:chat-view') === true } catch { return false } })(),
  },
  // The chat view of a Claude Code session (electron/chatHost.cjs; answered only while it is on)
  chat: {
    open: (id) => ipcRenderer.invoke('chat:open', String(id)),
    close: (id) => ipcRenderer.send('chat:close', String(id)),
    older: (id) => ipcRenderer.invoke('chat:older', String(id)),
    reload: (id) => ipcRenderer.invoke('chat:reload', String(id)),
    resync: (id) => ipcRenderer.invoke('chat:resync', String(id)),
    agent: (id, toolId) => ipcRenderer.invoke('chat:agent', { id: String(id), toolId: String(toolId) }),
    full: (id, itemId) => ipcRenderer.invoke('chat:full', { id: String(id), itemId: String(itemId) }),
    // the changes panel (Phase 5): the conversation's changed files, and one file's edits (read from the transcript)
    changes: (id) => ipcRenderer.invoke('chat:changes', String(id)),
    changeFile: (p) => ipcRenderer.invoke('chat:change-file', {
      id: String(p?.id ?? ''), file: String(p?.file ?? ''),
      ...(typeof p?.before === 'number' && Number.isFinite(p.before) ? { before: p.before } : {}),
    }),
    onUpdate: (fn) => on('chat:update', fn),
    // the composer (Phase 3): plain values only (strings, a list of strings); anything else is dropped
    send: (p) => ipcRenderer.invoke('chat:send', {
      id: String(p?.id ?? ''), sendId: String(p?.sendId ?? ''), text: typeof p?.text === 'string' ? p.text : '',
      images: Array.isArray(p?.images) ? p.images.filter(x => typeof x === 'string').slice(0, 64) : [], screen: String(p?.screen ?? ''),
      shell: p?.shell === true,
      // (the page's screen, read just now, shows the prompt box and no dialog over it: a stale wait may be let go)
      noDialog: p?.noDialog === true,
    }),
    submit: (p) => ipcRenderer.invoke('chat:submit', { id: String(p?.id ?? ''), sendId: String(p?.sendId ?? ''), echo: String(p?.echo ?? '') }),
    interrupt: (id) => ipcRenderer.invoke('chat:interrupt', String(id)),
    // the mode menu (2026-11-17): one Shift+Tab, checked in main
    cycleMode: (id) => ipcRenderer.invoke('chat:cycle-mode', String(id)),
    // the dialog card (2026-11-17): one key (up, down, enter, esc) or one line of words, checked in main
    dialogKey: (p) => ipcRenderer.invoke('chat:dialog-key', { id: String(p?.id ?? ''), key: String(p?.key ?? ''), ...(typeof p?.text === 'string' ? { text: p.text.slice(0, 4000) } : {}), ...(Number.isInteger(p?.n) ? { n: p.n } : {}) }),
    // an image's bytes (main checks them and names the file; the page never names a path) and its removal
    image: (p) => ipcRenderer.invoke('chat:image', { id: String(p?.id ?? ''), bytes: p?.bytes instanceof Uint8Array ? p.bytes : null }),
    dropImage: (p) => ipcRenderer.send('chat:image-drop', { id: String(p?.id ?? ''), token: String(p?.token ?? '') }),
    // the @ mention: names from the session's own folder (main picks the folder)
    files: (p) => ipcRenderer.invoke('chat:files', { id: String(p?.id ?? ''), query: String(p?.query ?? '').slice(0, 200) }),
    // the / menu: the session's own commands and skills (main picks the folders)
    commands: (p) => ipcRenderer.invoke('chat:commands', { id: String(p?.id ?? '') }),
    // a send whose page went away before its Enter (asked once as the composer opens)
    stranded: (id) => ipcRenderer.invoke('chat:stranded', String(id)),
    // the buttons (Phase 4): which session's chat is shown (or none), and an answer — its choice only
    // (main builds what is sent; the page never does)
    visible: (id) => ipcRenderer.send('chat:visible', { id: typeof id === 'string' && id ? id : null }),
    answer: (p) => ipcRenderer.invoke('chat:answer', {
      id: String(p?.id ?? ''), holdId: String(p?.holdId ?? ''), choice: String(p?.choice ?? ''),
      ...(Number.isInteger(p?.option) ? { option: p.option } : {}),
      // (several questions / a multi-select: each question's option indices, plain integers only)
      ...(Array.isArray(p?.picks) ? { picks: p.picks.slice(0, 4).map(x => (Array.isArray(x) ? x.filter(Number.isInteger).slice(0, 6) : [])) } : {}),
    }),
    // 7-48: one resize nudge for the shown chat's hidden terminal (main checks everything; never a write)
    redraw: (id) => ipcRenderer.invoke('chat:redraw', String(id)),
    // 1.5.3: a send the page refused for its screen, logged with the screen's shape (letters and digits masked)
    diag: (p) => ipcRenderer.send('chat:diag', { id: String(p?.id ?? '').slice(0, 200), why: String(p?.why ?? '').slice(0, 20), shape: String(p?.shape ?? '').slice(0, 3000) }),
    // link previews (Phase 5): one link's card for the view of terminal `id`, fetched by the chat worker (main answers
    // { ok: false } while off, and for a link that is not in that view's answers)
    preview: (p) => ipcRenderer.invoke('chat:preview', { id: String(p?.id ?? '').slice(0, 200), url: String(p?.url ?? '').slice(0, 4096) }),
  },
  cloud: {
    signIn: () => ipcRenderer.invoke('cloud:signin'),
    signOut: () => ipcRenderer.invoke('cloud:signout'),
    sync: () => ipcRenderer.invoke('cloud:sync'),
  },
  env: {
    check: () => ipcRenderer.invoke('env:check'),
    openLink: (key) => ipcRenderer.invoke('env:open-link', key),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    onChange: (fn) => on('settings:changed', fn),
    onOpen: (fn) => on('settings:open', fn),
    // 업무 모드 as the page starts, asked once and synchronously so the first paint
    // already hides the Pokémon (main.cjs answers it at once, before any window loads)
    workModeAtLoad: (() => { try { return ipcRenderer.sendSync('settings:work-mode') === true } catch { return false } })(),
  },
  board: {
    get: (board) => ipcRenderer.invoke('board:get', String(board)),
    profile: () => ipcRenderer.invoke('board:profile'),
    setProfile: (p) => ipcRenderer.invoke('board:set-profile', p),
  },
  data: {
    exportBackup: () => ipcRenderer.invoke('data:export'),
    openFolder: () => ipcRenderer.invoke('data:open-folder'),
  },
  toast: {
    show: (event) => ipcRenderer.send('toast:show', event),
    done: () => ipcRenderer.send('toast:done'),
    ready: () => ipcRenderer.send('toast:ready'),
    open: (id) => ipcRenderer.send('toast:open', Number(id)),
    onEvent: (fn) => on('toast:event', fn),
  },
  game: {
    throw: (sessionId, uid) => ipcRenderer.invoke('game:throw', { sessionId, uid }),
    release: (uid) => ipcRenderer.invoke('game:release', uid),
    // Kept for older pages; nothing calls it; always refused now that party is []
    exchange: (boxUid, partyUid) => ipcRenderer.invoke('game:exchange', { boxUid, partyUid }),
    arrange: (order) => ipcRenderer.invoke('game:arrange', order),
    swap: (sessionId, uid) => ipcRenderer.invoke('game:swap', { sessionId, uid }),
  },
  update: {
    get: () => ipcRenderer.invoke('update:get'),
    install: () => ipcRenderer.invoke('update:install'),
    restart: () => ipcRenderer.invoke('update:restart'),
    onState: (fn) => on('update:state', fn),
  },
  feedback: {
    capture: (rect) => ipcRenderer.invoke('feedback:capture', rect),
    send: (note) => ipcRenderer.invoke('feedback:send', note),
    copy: (note) => ipcRenderer.invoke('feedback:copy', note),
  },
  widget: {
    hide: () => ipcRenderer.invoke('widget:hide'),
    getMode: () => ipcRenderer.invoke('widget:get-mode'),
    minimize: () => ipcRenderer.invoke('widget:minimize'),
    setMode: (mode) => ipcRenderer.invoke('widget:set-mode', String(mode)),
    onMode: (fn) => on('widget:mode', fn),
    onOpenDex: (fn) => on('widget:open-dex', fn),
    resize: (width, height) => ipcRenderer.send('widget:resize', { width, height }),
    alert: (title, body) => ipcRenderer.send('widget:alert', { title, body }),
  },
})
