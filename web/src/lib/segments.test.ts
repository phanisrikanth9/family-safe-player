import { describe, expect, it } from 'vitest'
import {
  activeSegment,
  detectSegments,
  mergeSegments,
  PRESETS,
  refinementTimes,
  skipTarget,
  type DetectOptions,
  type FrameScore,
  type Segment,
} from './segments'
import { parseSkipFile, parseTime, formatTime, toEDL, toSkipFile } from './formats'
import { languageSegments, parseSubtitles, censor, profanityRegex } from './subtitles'

/** Build frames at 1 fps from a list of explicit scores. */
const frames = (scores: number[], step = 1, suggestive: number[] = []): FrameScore[] =>
  scores.map((e, i) => ({ t: i * step, explicit: e, suggestive: suggestive[i] ?? 0 }))

const opts = (o: Partial<DetectOptions> = {}): DetectOptions => ({
  hi: 0.6,
  lo: 0.35,
  suggestiveWeight: 0,
  minDuration: 1,
  mergeGap: 0,
  pad: 0,
  duration: 100,
  ...o,
})

const seg = (start: number, end: number, extra: Partial<Segment> = {}): Segment => ({
  id: `${start}`,
  start,
  end,
  category: 'nudity',
  action: 'skip',
  enabled: true,
  peak: 1,
  ...extra,
})

describe('detectSegments', () => {
  it('finds nothing in a clean video', () => {
    expect(detectSegments(frames([0, 0.1, 0.2, 0.1, 0]), opts())).toEqual([])
  })

  it('finds one scene and covers until the next sample', () => {
    const s = detectSegments(frames([0, 0, 0.9, 0.95, 0.8, 0, 0]), opts())
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ start: 2, end: 5, category: 'nudity' })
  })

  it('uses hysteresis: a dip below hi but above lo does not split the scene', () => {
    const s = detectSegments(frames([0, 0.7, 0.4, 0.45, 0.7, 0.1]), opts())
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ start: 1, end: 5 })
  })

  it('does not open a segment on frames between lo and hi', () => {
    expect(detectSegments(frames([0, 0.5, 0.5, 0.5, 0]), opts())).toEqual([])
  })

  it('drops very short blips unless they are confident', () => {
    const weak = frames([0, 0.65, 0, 0])
    expect(detectSegments(weak, opts({ minDuration: 2 }))).toEqual([])
    const strong = frames([0, 0.97, 0, 0])
    expect(detectSegments(strong, opts({ minDuration: 2 }))).toHaveLength(1)
  })

  it('pads and clamps to the video length', () => {
    const s = detectSegments(frames([0.9, 0.9, 0]), opts({ pad: 2, duration: 3 }))
    expect(s[0].start).toBe(0)
    const e = detectSegments(frames([0, 0, 0.9]), opts({ pad: 5, duration: 3 }))
    expect(e[0].end).toBe(3)
  })

  it('merges scenes separated by a short gap', () => {
    const f = frames([0.9, 0.9, 0, 0, 0.9, 0.9, 0])
    expect(detectSegments(f, opts({ mergeGap: 0 }))).toHaveLength(2)
    expect(detectSegments(f, opts({ mergeGap: 3 }))).toHaveLength(1)
  })

  it('counts the suggestive class only with a weight', () => {
    const f = frames([0, 0, 0, 0], 1, [0, 0.9, 0.9, 0])
    expect(detectSegments(f, opts({ suggestiveWeight: 0 }))).toEqual([])
    const s = detectSegments(f, opts({ suggestiveWeight: 1 }))
    expect(s).toHaveLength(1)
    expect(s[0].category).toBe('suggestive')
  })

  it('handles unsorted, duplicated and uneven samples (refinement pass)', () => {
    const f: FrameScore[] = [
      { t: 3, explicit: 0, suggestive: 0 },
      { t: 1, explicit: 0.9, suggestive: 0 },
      { t: 0, explicit: 0, suggestive: 0 },
      { t: 2, explicit: 0.9, suggestive: 0 },
      { t: 0.75, explicit: 0.8, suggestive: 0 },
      { t: 1, explicit: 0.9, suggestive: 0 },
      { t: 2.75, explicit: 0.1, suggestive: 0 },
    ]
    const s = detectSegments(f, opts())
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ start: 0.75, end: 2.75 })
  })

  it('records the peak frame for thumbnails', () => {
    const s = detectSegments(frames([0, 0.7, 0.99, 0.7, 0]), opts())
    expect(s[0].peak).toBeCloseTo(0.99)
    expect(s[0].peakAt).toBe(2)
  })

  it('presets get stricter in the right order', () => {
    const f = frames([0, 0.5, 0.55, 0.5, 0], 1, [0, 0.3, 0.3, 0.3, 0])
    const n = (p: keyof typeof PRESETS) => detectSegments(f, { ...PRESETS[p], duration: 5 }).length
    expect(n('strict')).toBe(1)
    expect(n('standard')).toBe(1)
    expect(n('lenient')).toBe(0)
  })
})

describe('refinementTimes', () => {
  it('samples finely around both edges of each scene only', () => {
    const f = frames([0, 0, 0, 0.9, 0.9, 0, 0, 0, 0, 0])
    const t = refinementTimes(f, opts({ duration: 10 }), 1, 0.25)
    expect(t.length).toBeGreaterThan(0)
    expect(Math.min(...t)).toBeGreaterThanOrEqual(2)
    expect(Math.max(...t)).toBeLessThanOrEqual(6)
    expect(t).not.toContain(3) // already sampled
  })
})

describe('playback helpers', () => {
  const segs = [seg(10, 20), seg(20, 25), seg(40, 45, { action: 'mute' }), seg(50, 60, { enabled: false })]

  it('chains back-to-back skips', () => {
    expect(skipTarget(segs, 12)).toBe(25)
  })
  it('does not skip mute segments or disabled ones', () => {
    expect(skipTarget(segs, 41)).toBeNull()
    expect(skipTarget(segs, 55)).toBeNull()
    expect(activeSegment(segs, 41, 'mute')?.start).toBe(40)
  })
  it('treats the end as exclusive', () => {
    expect(activeSegment(segs, 25)).toBeUndefined()
  })
})

describe('mergeSegments', () => {
  it('keeps the stronger category', () => {
    const m = mergeSegments([seg(0, 5, { category: 'suggestive' }), seg(6, 8, { category: 'nudity' })], 2)
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ start: 0, end: 8, category: 'nudity' })
  })
  it('never merges a mute into a skip', () => {
    expect(mergeSegments([seg(0, 5), seg(5, 8, { action: 'mute' })], 2)).toHaveLength(2)
  })
})

describe('skip file formats', () => {
  it('round-trips through JSON and drops disabled segments', () => {
    const file = toSkipFile('Test', 5400.12345, [seg(10, 20), seg(30, 31, { enabled: false })])
    expect(file.segments).toHaveLength(1)
    const back = parseSkipFile(JSON.stringify(file))
    expect(back.title).toBe('Test')
    expect(back.duration).toBe(5400.123)
    expect(back.segments[0]).toMatchObject({ start: 10, end: 20, action: 'skip' })
  })

  it('rejects bad files with a readable reason', () => {
    expect(() => parseSkipFile('nope')).toThrow(/JSON/)
    expect(() => parseSkipFile('{"a":1}')).toThrow(/not a Family Safe/)
    const bad = { format: 'family-safe-skips', version: 1, segments: [{ start: 5, end: 2 }] }
    expect(() => parseSkipFile(JSON.stringify(bad))).toThrow(/Segment 1/)
    const future = { format: 'family-safe-skips', version: 99, segments: [] }
    expect(() => parseSkipFile(JSON.stringify(future))).toThrow(/newer/)
  })

  it('writes Kodi/MPlayer EDL', () => {
    expect(toEDL([seg(1, 2), seg(3, 4, { action: 'mute' })])).toBe('1.000\t2.000\t0\n3.000\t4.000\t1\n')
  })

  it('formats and parses times', () => {
    expect(formatTime(3725)).toBe('1:02:05')
    expect(formatTime(65)).toBe('1:05')
    expect(parseTime('1:02:05')).toBe(3725)
    expect(parseTime('90.5')).toBe(90.5)
    expect(parseTime('a:b')).toBeNull()
  })
})

describe('subtitles', () => {
  const srt = `﻿1\r\n00:00:01,000 --> 00:00:03,500\r\nHello there.\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000 align:start\r\n<i>What the fuck</i>\r\nis this?\r\n\r\n3\r\n00:00:10,000 --> 00:00:12,000\r\nThis class is in Scunthorpe.\r\n\r\n4\r\n00:01:00.000 --> 00:01:02.000\r\nDamn it.\r\n`

  it('parses SRT/VTT cues', () => {
    const cues = parseSubtitles(srt)
    expect(cues).toHaveLength(4)
    expect(cues[1]).toEqual({ start: 4, end: 6, text: 'What the fuck is this?' })
    expect(cues[3].start).toBe(60)
  })

  it('mutes strong language only at the strong level, without false hits', () => {
    const cues = parseSubtitles(srt)
    const strong = languageSegments(cues, 'strong')
    expect(strong).toHaveLength(1)
    expect(strong[0]).toMatchObject({ action: 'mute', category: 'language' })
    expect(strong[0].start).toBeCloseTo(3.85)
    expect(languageSegments(cues, 'all')).toHaveLength(2)
  })

  it('supports custom words and censors notes', () => {
    const cues = parseSubtitles(srt)
    expect(languageSegments(cues, 'strong', ['class'])).toHaveLength(2)
    expect(censor('What the fuck', profanityRegex('strong'))).toBe('What the f***')
  })
})

describe('formatTimePrecise', () => {
  it('shows tenths without rounding up into the next second', async () => {
    const { formatTimePrecise } = await import('./formats')
    expect(formatTimePrecise(62.95)).toBe('1:02.9')
    expect(formatTimePrecise(3725.3)).toBe('1:02:05.3')
    expect(parseTime(formatTimePrecise(62.9))).toBeCloseTo(62.9)
  })
})
