// Pure logic for turning per-frame model scores into skip segments.
// No DOM, no TensorFlow: everything here is unit-tested in segments.test.ts.

export type Category = 'nudity' | 'suggestive' | 'language' | 'custom'
export type Action = 'skip' | 'mute' | 'blackout'

/** One sampled frame. Probabilities come from the NSFW classifier (0..1). */
export interface FrameScore {
  t: number // seconds
  explicit: number // P(porn) + P(hentai)
  suggestive: number // P(sexy)
}

export interface Segment {
  id: string
  start: number
  end: number
  category: Category
  action: Action
  enabled: boolean
  /** highest frame score inside the segment, 0..1 (1 for manual / subtitle segments) */
  peak: number
  /** time of the highest-scoring frame, used for the review thumbnail */
  peakAt?: number
  note?: string
}

export interface DetectOptions {
  /** open a segment when the frame score reaches this */
  hi: number
  /** keep it open while the score stays at or above this (hysteresis) */
  lo: number
  /** how much the "suggestive" class counts towards the score (0 = ignore) */
  suggestiveWeight: number
  /** drop segments shorter than this unless they contain a very confident frame */
  minDuration: number
  /** merge segments separated by less than this many seconds */
  mergeGap: number
  /** extra seconds added before and after each segment */
  pad: number
  /** video length, used to clamp padded segments */
  duration: number
}

export type Strictness = 'strict' | 'standard' | 'lenient'

export const PRESETS: Record<Strictness, Omit<DetectOptions, 'duration'>> = {
  // Also skips kissing in underwear, swimsuit scenes, etc. Expect more false alarms.
  strict: { hi: 0.45, lo: 0.25, suggestiveWeight: 1, minDuration: 1, mergeGap: 6, pad: 1.5 },
  // Nudity and sex scenes, plus strongly suggestive ones.
  standard: { hi: 0.6, lo: 0.35, suggestiveWeight: 0.5, minDuration: 1, mergeGap: 4, pad: 1 },
  // Only clearly explicit content.
  lenient: { hi: 0.8, lo: 0.5, suggestiveWeight: 0, minDuration: 1.5, mergeGap: 3, pad: 0.75 },
}

/** A single frame this confident is kept even if the segment is very short. */
const CONFIDENT = 0.9

export function frameScore(f: FrameScore, suggestiveWeight: number): number {
  return Math.min(1, f.explicit + suggestiveWeight * f.suggestive)
}

let counter = 0
export function newId(prefix = 'seg'): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

/**
 * Hysteresis thresholding over the (possibly unevenly spaced) frames.
 * Each frame "covers" the time until the next sampled frame.
 */
export function detectSegments(frames: FrameScore[], opt: DetectOptions): Segment[] {
  const sorted = dedupeByTime(frames)
  if (sorted.length === 0) return []

  const typicalStep = medianStep(sorted)
  const raw: { start: number; end: number; peak: number; peakAt: number; peakExplicit: number }[] = []
  let open: (typeof raw)[number] | null = null

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]
    const s = frameScore(f, opt.suggestiveWeight)
    const coverEnd = i + 1 < sorted.length ? sorted[i + 1].t : f.t + typicalStep
    if (open) {
      if (s >= opt.lo) {
        open.end = coverEnd
        if (s > open.peak) {
          open.peak = s
          open.peakAt = f.t
        }
        open.peakExplicit = Math.max(open.peakExplicit, f.explicit)
      } else {
        raw.push(open)
        open = null
      }
    }
    if (!open && s >= opt.hi) {
      open = { start: f.t, end: coverEnd, peak: s, peakAt: f.t, peakExplicit: f.explicit }
    }
  }
  if (open) raw.push(open)

  const kept = raw.filter((r) => r.end - r.start >= opt.minDuration || r.peak >= CONFIDENT)

  const segs: Segment[] = kept.map((r) => ({
    id: newId(),
    start: clamp(r.start - opt.pad, 0, opt.duration),
    end: clamp(r.end + opt.pad, 0, opt.duration),
    category: r.peakExplicit >= 0.5 ? 'nudity' : 'suggestive',
    action: 'skip',
    enabled: true,
    peak: round(r.peak),
    peakAt: r.peakAt,
  }))

  return mergeSegments(segs, opt.mergeGap)
}

/** Merge overlapping or nearly touching segments. Keeps the stronger category/peak. */
export function mergeSegments(segs: Segment[], gap: number): Segment[] {
  const sorted = [...segs].sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && s.start - last.end <= gap && last.action === s.action) {
      last.end = Math.max(last.end, s.end)
      if (s.peak > last.peak) {
        last.peak = s.peak
        last.peakAt = s.peakAt
      }
      if (rank(s.category) > rank(last.category)) last.category = s.category
    } else {
      out.push({ ...s })
    }
  }
  return out
}

function rank(c: Category): number {
  return { custom: 0, language: 1, suggestive: 2, nudity: 3 }[c]
}

/**
 * Times to re-sample in a second, finer pass so segment edges are accurate
 * to about `step` seconds instead of the coarse sampling interval.
 */
export function refinementTimes(frames: FrameScore[], opt: DetectOptions, coarseStep: number, step = 0.25): number[] {
  const unpadded = detectSegments(frames, { ...opt, pad: 0, mergeGap: 0, minDuration: 0 })
  const have = new Set(frames.map((f) => key(f.t)))
  const times: number[] = []
  for (const s of unpadded) {
    for (const edge of [s.start, s.end]) {
      for (let t = edge - coarseStep; t <= edge + coarseStep; t += step) {
        const tt = round(clamp(t, 0, Math.max(0, opt.duration - 0.05)))
        if (!have.has(key(tt))) {
          have.add(key(tt))
          times.push(tt)
        }
      }
    }
  }
  return times.sort((a, b) => a - b)
}

/** The enabled segment covering time t, if any. */
export function activeSegment(segs: Segment[], t: number, action?: Action): Segment | undefined {
  return segs.find((s) => s.enabled && t >= s.start && t < s.end && (!action || s.action === action))
}

/**
 * Where playback should jump to from time t. Handles back-to-back skip segments
 * so the player doesn't land inside the next one.
 */
export function skipTarget(segs: Segment[], t: number): number | null {
  let cur = activeSegment(segs, t, 'skip')
  if (!cur) return null
  let target = cur.end
  for (let guard = 0; guard < 50; guard++) {
    cur = activeSegment(segs, target + 0.01, 'skip')
    if (!cur) break
    target = cur.end
  }
  return target
}

export function totalFiltered(segs: Segment[]): number {
  return segs.filter((s) => s.enabled).reduce((sum, s) => sum + (s.end - s.start), 0)
}

// ---------- helpers ----------

function dedupeByTime(frames: FrameScore[]): FrameScore[] {
  const m = new Map<string, FrameScore>()
  for (const f of frames) m.set(key(f.t), f)
  return [...m.values()].sort((a, b) => a.t - b.t)
}

function medianStep(sorted: FrameScore[]): number {
  if (sorted.length < 2) return 1
  const d: number[] = []
  for (let i = 1; i < sorted.length; i++) d.push(sorted[i].t - sorted[i - 1].t)
  d.sort((a, b) => a - b)
  return d[Math.floor(d.length / 2)] || 1
}

const key = (t: number) => t.toFixed(2)
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const round = (v: number, p = 3) => Math.round(v * 10 ** p) / 10 ** p
