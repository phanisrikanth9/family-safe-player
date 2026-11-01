import { useEffect, useRef } from 'react'
import { frameScore, type FrameScore, type Segment } from '../lib/segments'
import { formatTime } from '../lib/formats'

interface Props {
  duration: number
  frames: FrameScore[]
  segments: Segment[]
  suggestiveWeight: number
  current: number
  scannedUpTo?: number
  onSeek: (t: number) => void
}

const COLORS: Record<Segment['category'], string> = {
  nudity: 'var(--c-nudity)',
  suggestive: 'var(--c-suggestive)',
  language: 'var(--c-language)',
  custom: 'var(--c-custom)',
}

/** Score "heat strip" drawn on a canvas, with segments and the playhead on top. */
export function Timeline({ duration, frames, segments, suggestiveWeight, current, scannedUpTo, onSeek }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = canvas.current
    if (!c || !duration) return
    const w = (c.width = c.clientWidth * devicePixelRatio)
    const h = (c.height = c.clientHeight * devicePixelRatio)
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    // Bucket frames per pixel column and draw the max score as a bar.
    const cols = new Float32Array(Math.max(1, Math.floor(w)))
    for (const f of frames) {
      const x = Math.min(cols.length - 1, Math.floor((f.t / duration) * cols.length))
      cols[x] = Math.max(cols[x], frameScore(f, suggestiveWeight))
    }
    const css = getComputedStyle(c)
    const base = css.getPropertyValue('--strip-base').trim() || '#2a3346'
    const hot = css.getPropertyValue('--strip-hot').trim() || '#ff6b5b'
    for (let x = 0; x < cols.length; x++) {
      const s = cols[x]
      if (s <= 0.02) continue
      const bh = Math.max(2, s * h)
      ctx.fillStyle = s > 0.5 ? hot : base
      ctx.globalAlpha = 0.35 + 0.65 * s
      ctx.fillRect(x, h - bh, 1, bh)
    }
    ctx.globalAlpha = 1
  }, [frames, duration, suggestiveWeight])

  if (!duration) return null
  const pct = (t: number) => `${(t / duration) * 100}%`

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    onSeek(((e.clientX - r.left) / r.width) * duration)
  }

  return (
    <div className="timeline">
      <div
        className="timeline-track"
        onClick={onClick}
        role="slider"
        aria-label="Film timeline"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        tabIndex={0}
      >
        <canvas ref={canvas} className="timeline-strip" />
        {scannedUpTo != null && scannedUpTo < duration && (
          <div className="timeline-unscanned" style={{ left: pct(scannedUpTo) }} />
        )}
        {segments.map((s) => (
          <div
            key={s.id}
            className={`timeline-seg ${s.enabled ? '' : 'off'} ${s.action}`}
            style={{ left: pct(s.start), width: `max(3px, ${pct(s.end - s.start)})`, color: COLORS[s.category] }}
            title={`${formatTime(s.start)}–${formatTime(s.end)} · ${s.category}`}
          />
        ))}
        <div className="timeline-head" style={{ left: pct(current) }} />
      </div>
      <div className="timeline-scale">
        <span>0:00</span>
        <span>{formatTime(duration / 2)}</span>
        <span>{formatTime(duration)}</span>
      </div>
    </div>
  )
}
