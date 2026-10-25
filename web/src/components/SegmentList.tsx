import { useState } from 'react'
import type { Action, Segment } from '../lib/segments'
import { formatTimePrecise, parseTime } from '../lib/formats'

interface Props {
  segments: Segment[]
  thumbs: Record<string, string>
  duration: number
  onChange: (id: string, patch: Partial<Segment>) => void
  onRemove: (id: string) => void
  onCheck: (s: Segment) => void
  onJump: (t: number) => void
}

const CAT_LABEL: Record<Segment['category'], string> = {
  nudity: 'Nudity / sex',
  suggestive: 'Suggestive',
  language: 'Language',
  custom: 'Marked by you',
}

export function SegmentList({ segments, thumbs, duration, onChange, onRemove, onCheck, onJump }: Props) {
  if (segments.length === 0) {
    return <p className="empty">No scenes flagged. Mark one yourself from the player, or try a stricter setting.</p>
  }
  return (
    <ol className="seg-list">
      {segments.map((s, i) => (
        <SegmentRow
          key={s.id}
          n={i + 1}
          s={s}
          thumb={s.peakAt != null ? thumbs[s.peakAt.toFixed(2)] : undefined}
          duration={duration}
          onChange={(p) => onChange(s.id, p)}
          onRemove={() => onRemove(s.id)}
          onCheck={() => onCheck(s)}
          onJump={onJump}
        />
      ))}
    </ol>
  )
}

function SegmentRow({
  n,
  s,
  thumb,
  duration,
  onChange,
  onRemove,
  onCheck,
  onJump,
}: {
  n: number
  s: Segment
  thumb?: string
  duration: number
  onChange: (p: Partial<Segment>) => void
  onRemove: () => void
  onCheck: () => void
  onJump: (t: number) => void
}) {
  const [reveal, setReveal] = useState(false)
  const nudge = (field: 'start' | 'end', d: number) => {
    const v = Math.min(duration, Math.max(0, s[field] + d))
    if (field === 'start' && v >= s.end) return
    if (field === 'end' && v <= s.start) return
    onChange({ [field]: Math.round(v * 100) / 100 })
  }
  return (
    <li className={`seg ${s.enabled ? '' : 'off'}`}>
      <div className="seg-thumb">
        {thumb ? (
          <button
            type="button"
            className="thumb-btn"
            aria-label="Hold to reveal the frame"
            onPointerDown={() => setReveal(true)}
            onPointerUp={() => setReveal(false)}
            onPointerLeave={() => setReveal(false)}
          >
            <img src={thumb} alt="" style={{ filter: reveal ? 'none' : 'blur(14px) saturate(0.6)' }} draggable={false} />
            {!reveal && <span>Hold to peek</span>}
          </button>
        ) : (
          <div className={`thumb-ph cat-${s.category}`}>{n}</div>
        )}
      </div>
      <div className="seg-body">
        <div className="seg-head">
          <span className={`cat cat-${s.category}`}>{CAT_LABEL[s.category]}</span>
          {s.category !== 'language' && s.category !== 'custom' && (
            <span className="muted small">confidence {Math.round(s.peak * 100)}%</span>
          )}
          <label className="seg-toggle">
            <input type="checkbox" checked={s.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
            {s.enabled ? 'Filtering' : 'Ignored'}
          </label>
        </div>
        {s.note && <p className="seg-note">“{s.note}”</p>}
        <div className="seg-times">
          <TimeField label="From" value={s.start} onNudge={(d) => nudge('start', d)} onSet={(v) => v < s.end && onChange({ start: v })} onJump={onJump} />
          <TimeField label="To" value={s.end} onNudge={(d) => nudge('end', d)} onSet={(v) => v > s.start && v <= duration && onChange({ end: v })} onJump={onJump} />
          <span className="muted small">{(s.end - s.start).toFixed(1)}s</span>
        </div>
        <div className="seg-actions">
          <select value={s.action} onChange={(e) => onChange({ action: e.target.value as Action })} aria-label="What to do">
            <option value="skip">Skip it</option>
            <option value="mute">Mute audio</option>
            <option value="blackout">Black screen + mute</option>
          </select>
          <button type="button" className="ghost" onClick={onCheck} title="Plays from 3 seconds before, with the filter on">
            Check the cut
          </button>
          <button type="button" className="ghost danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
    </li>
  )
}

function TimeField({
  label,
  value,
  onNudge,
  onSet,
  onJump,
}: {
  label: string
  value: number
  onNudge: (d: number) => void
  onSet: (v: number) => void
  onJump: (t: number) => void
}) {
  const [text, setText] = useState<string | null>(null)
  return (
    <span className="tf">
      <button type="button" className="tf-label" onClick={() => onJump(value)} title="Jump the player here (filter stays on)">
        {label}
      </button>
      <button type="button" className="tf-n" onClick={() => onNudge(-0.5)} aria-label={`${label} earlier`}>
        −
      </button>
      <input
        value={text ?? formatTimePrecise(value)}
        onFocus={(e) => setText(e.target.value)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const v = text == null ? null : parseTime(text)
          if (v != null) onSet(v)
          setText(null)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label={`${label} time`}
      />
      <button type="button" className="tf-n" onClick={() => onNudge(0.5)} aria-label={`${label} later`}>
        +
      </button>
    </span>
  )
}
