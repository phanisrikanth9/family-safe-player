import { useEffect, useRef, useState } from 'react'

/**
 * The hero: a strip of film frames with a playhead that plays through it and jumps
 * over the flagged frames, the way the player does with a real film.
 * Respects prefers-reduced-motion by showing a still frame of the skip.
 */

interface Frame {
  sky: string
  ground: string
  sun?: string
  flagged?: boolean
}

const FRAMES: Frame[] = [
  { sky: '#2b3f73', ground: '#1b2347', sun: '#ffd59a' },
  { sky: '#3e4f8f', ground: '#23295a', sun: '#ffe2b8' },
  { sky: '#6a4f8f', ground: '#2f2350', sun: '#ffc48a' },
  { sky: '#8e5a86', ground: '#3a2346' },
  { sky: '#c0727a', ground: '#4a2440', sun: '#ffd0a0', flagged: true },
  { sky: '#d98377', ground: '#542742', flagged: true },
  { sky: '#c56c78', ground: '#4b2342', flagged: true },
  { sky: '#5d4b8a', ground: '#2b2250', sun: '#ffe9c7' },
  { sky: '#344a86', ground: '#1e2650' },
  { sky: '#2a3d70', ground: '#18204a', sun: '#fff1d6' },
  { sky: '#7a5a94', ground: '#33244f', flagged: true },
  { sky: '#3f5c94', ground: '#1f2a55', sun: '#ffd59a' },
  { sky: '#2c4277', ground: '#19214a' },
  { sky: '#4a5c99', ground: '#222b5c', sun: '#ffe2b8' },
]

const SPEED = 0.055 // frames per animation tick at 60fps ≈ 3.3 frames per second

function flaggedRanges(frames: Frame[]): [number, number][] {
  const out: [number, number][] = []
  frames.forEach((f, i) => {
    if (!f.flagged) return
    const last = out[out.length - 1]
    if (last && last[1] === i) last[1] = i + 1
    else out.push([i, i + 1])
  })
  return out
}

export function Filmstrip() {
  const [pos, setPos] = useState(3.2) // playhead position in frames
  const [skip, setSkip] = useState<{ from: number; to: number; id: number } | null>(null)
  const raf = useRef(0)
  const ranges = flaggedRanges(FRAMES)

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduce) {
      setPos(7.4)
      setSkip({ from: 4, to: 7, id: 0 })
      return
    }
    let p = 0.2
    let pause = 0
    let n = 0
    const tick = () => {
      if (pause > 0) {
        pause -= 1
      } else {
        p += SPEED
        const hit = ranges.find(([a]) => p >= a - 0.02 && p < a + SPEED)
        if (hit) {
          n += 1
          setSkip({ from: hit[0], to: hit[1], id: n })
          p = hit[1] + 0.01
          pause = 10 // a beat after the jump, so the eye can follow it
        }
        if (p >= FRAMES.length - 0.05) {
          p = 0.2
          pause = 40
        }
      }
      setPos(p)
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
    // ranges is derived from a constant
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pct = (f: number) => `${(f / FRAMES.length) * 100}%`
  const seconds = skip ? (skip.to - skip.from) * 14 : 0

  return (
    <figure className="strip" aria-label="Animation: the playhead plays through a film strip and jumps over flagged scenes">
      <div className="strip-film">
        <div className="sprockets" aria-hidden />
        <div className="strip-frames">
          {FRAMES.map((f, i) => (
            <div key={i} className={`frame ${f.flagged ? 'flagged' : ''} ${pos >= i && pos < i + 1 ? 'live' : ''}`}>
              <FrameArt f={f} />
              {f.flagged && <span className="frame-flag" aria-hidden />}
            </div>
          ))}
        </div>
        <div className="sprockets" aria-hidden />
        {skip && (
          <div
            key={skip.id}
            className="strip-jump"
            style={{ left: pct(skip.from), width: pct(skip.to - skip.from) }}
            aria-hidden
          />
        )}
        <div className="strip-head" style={{ left: pct(pos) }} aria-hidden />
      </div>
      <figcaption>
        <span className="strip-legend">
          <i className="dot flag" /> flagged by the model
        </span>
        {skip && (
          <span key={skip.id} className="strip-toast">
            Skipped 0:{String(seconds).padStart(2, '0')} · nudity
          </span>
        )}
      </figcaption>
    </figure>
  )
}

function FrameArt({ f }: { f: Frame }) {
  return (
    <svg viewBox="0 0 64 40" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <linearGradient id={`g${f.sky.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={f.sky} />
          <stop offset="1" stopColor={f.ground} />
        </linearGradient>
      </defs>
      <rect width="64" height="40" fill={`url(#g${f.sky.slice(1)})`} />
      {f.sun && <circle cx="44" cy="17" r="5" fill={f.sun} opacity="0.9" />}
      <path d="M0 30 Q16 24 30 29 T64 27 V40 H0Z" fill={f.ground} opacity="0.9" />
      {!f.flagged && (
        <g fill="#0d0a18" opacity="0.75">
          <circle cx="18" cy="25" r="2.4" />
          <rect x="16" y="27" width="4.8" height="7" rx="2" />
          <circle cx="25" cy="26" r="2" />
          <rect x="23.2" y="27.8" width="4" height="6" rx="1.8" />
        </g>
      )}
    </svg>
  )
}
