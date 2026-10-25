// Skip-file formats: our JSON (shared with the browser extension) and EDL.

import { newId, type Action, type Category, type Segment } from './segments'

export const SKIP_FILE_VERSION = 1

export interface SkipFile {
  format: 'family-safe-skips'
  version: number
  title: string
  /** seconds; lets the extension warn when a file doesn't match the video */
  duration: number | null
  createdAt: string
  createdWith: string
  segments: Pick<Segment, 'start' | 'end' | 'category' | 'action' | 'note'>[]
}

export function toSkipFile(title: string, duration: number | null, segs: Segment[]): SkipFile {
  return {
    format: 'family-safe-skips',
    version: SKIP_FILE_VERSION,
    title,
    duration: duration == null ? null : Math.round(duration * 1000) / 1000,
    createdAt: new Date().toISOString(),
    createdWith: 'Family Safe Player (web)',
    segments: segs
      .filter((s) => s.enabled)
      .sort((a, b) => a.start - b.start)
      .map(({ start, end, category, action, note }) => ({
        start: r3(start),
        end: r3(end),
        category,
        action,
        ...(note ? { note } : {}),
      })),
  }
}

const CATEGORIES: Category[] = ['nudity', 'suggestive', 'language', 'custom']
const ACTIONS: Action[] = ['skip', 'mute', 'blackout']

/** Parse and validate a skip file. Throws a readable Error on bad input. */
export function parseSkipFile(text: string): { title: string; duration: number | null; segments: Segment[] } {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Not a valid JSON file.')
  }
  const d = data as Partial<SkipFile>
  if (d.format !== 'family-safe-skips' || !Array.isArray(d.segments)) {
    throw new Error('This is not a Family Safe skip file.')
  }
  if (typeof d.version !== 'number' || d.version > SKIP_FILE_VERSION) {
    throw new Error('This skip file was made by a newer version.')
  }
  const segments: Segment[] = d.segments.map((s, i) => {
    const start = Number(s.start)
    const end = Number(s.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
      throw new Error(`Segment ${i + 1} has invalid times.`)
    }
    return {
      id: newId('imp'),
      start,
      end,
      category: CATEGORIES.includes(s.category as Category) ? (s.category as Category) : 'custom',
      action: ACTIONS.includes(s.action as Action) ? (s.action as Action) : 'skip',
      enabled: true,
      peak: 1,
      note: typeof s.note === 'string' ? s.note.slice(0, 200) : undefined,
    }
  })
  return {
    title: typeof d.title === 'string' ? d.title : 'Untitled',
    duration: typeof d.duration === 'number' ? d.duration : null,
    segments,
  }
}

/**
 * Edit Decision List understood by Kodi and MPlayer: "start end action" per line,
 * action 0 = cut (skip), 1 = mute. Blackout has no EDL equivalent, so it is written as a cut.
 */
export function toEDL(segs: Segment[]): string {
  return (
    segs
      .filter((s) => s.enabled)
      .sort((a, b) => a.start - b.start)
      .map((s) => `${s.start.toFixed(3)}\t${s.end.toFixed(3)}\t${s.action === 'mute' ? 1 : 0}`)
      .join('\n') + '\n'
  )
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec)) return '--:--'
  const s = Math.max(0, sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  const mm = String(m).padStart(h ? 2 : 1, '0')
  return (h ? `${h}:` : '') + `${mm}:${String(ss).padStart(2, '0')}`
}

/** Accepts "1:02:03.5", "62:03", "93.5". Returns seconds or null. */
export function parseTime(text: string): number | null {
  const parts = text.trim().split(':')
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => p === '' || isNaN(Number(p)))) return null
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0)
}

const r3 = (v: number) => Math.round(v * 1000) / 1000

/** Like formatTime but with tenths of a second: "1:02:05.3". */
export function formatTimePrecise(sec: number): string {
  const t = Math.floor(Math.max(0, sec) * 10 + 1e-6) / 10
  return `${formatTime(t)}.${Math.round((t % 1) * 10) % 10}`
}
