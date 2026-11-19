/**
 * PatchNotes — after an update, the first start shows once what is new
 * (the CHANGELOG entries since the version this PC last ran).
 * PatchNotesHistory — every release, opened from the spawn name in the header.
 */

import React, { useEffect, useState } from 'react'
import changelog from '../../CHANGELOG.md?raw'
import { bridge } from '../desktop'
import { t, lang } from '../i18n'
import { notesToShow, releasesIn, readSeenVersion, writeSeenVersion, type Release } from '../patchNotes'

export const PatchNotes: React.FC = () => {
  const [show, setShow] = useState<{ current: string; releases: Release[] } | null>(null)

  useEffect(() => {
    let alive = true
    bridge?.update.get().then(state => {
      const current = state?.current
      if (!alive || !current) return
      const releases = notesToShow(releasesIn(changelog, lang()), current, readSeenVersion())
      // Seen as soon as it is shown: a widget <-> window swap builds a new page,
      // which must not open the same notes again
      writeSeenVersion(current)
      if (releases.length) setShow({ current, releases })
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  if (!show) return null
  return <NotesModal title={t('spawn {version} 새 소식', { version: show.current })} releases={show.releases} onClose={() => setShow(null)} />
}

/**
 * Every release, kept (none goes missing): grouped by minor version (1.10, 1.9, …), the
 * newest group open, the older ones folded under their version range
 */
export const PatchNotesHistory: React.FC<{ onClose: () => void }> = ({ onClose }) =>
  <NotesModal title={t('패치노트')} releases={releasesIn(changelog, lang())} onClose={onClose} grouped />

/** Releases by minor version, newest first: [{ minor: '1.10', releases }] */
export function byMinor(releases: Release[]): { minor: string; releases: Release[] }[] {
  const out: { minor: string; releases: Release[] }[] = []
  for (const r of releases) {
    const minor = r.version.split('.').slice(0, 2).join('.')
    const g = out[out.length - 1]
    if (g && g.minor === minor) g.releases.push(r); else out.push({ minor, releases: [r] })
  }
  return out
}

const Releases: React.FC<{ releases: Release[] }> = ({ releases }) => <>
  {releases.map(r => (
    <section key={r.version}>
      <h3>{r.version}</h3>
      <ul>{r.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
    </section>
  ))}
</>

const NotesModal: React.FC<{ title: string; releases: Release[]; onClose: () => void; grouped?: boolean }> = ({ title, releases, onClose: close, grouped }) => {
  return (
    <div className="resume-backdrop" onClick={close}>
      <div className="resume-modal w-notes" onClick={e => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="resume-head">
          <span>{title}</span>
          <button onClick={close} aria-label={t('닫기')}>×</button>
        </div>
        <div className="w-notes-body">
          {grouped ? byMinor(releases).map((g, i) => (
            <details key={g.minor} className="w-notes-group" open={i === 0}>
              <summary>
                <span className="w-notes-minor">{g.minor}</span>
                <span className="w-notes-range">{g.releases.length > 1 ? `${g.releases[g.releases.length - 1].version} – ${g.releases[0].version}` : g.releases[0].version} · {t('{n}번', { n: g.releases.length })}</span>
              </summary>
              <Releases releases={g.releases} />
            </details>
          )) : <Releases releases={releases} />}
        </div>
        <div className="w-notes-foot">
          <button className="w-notes-ok" onClick={close} autoFocus>{t('확인')}</button>
        </div>
      </div>
    </div>
  )
}

export default PatchNotes
