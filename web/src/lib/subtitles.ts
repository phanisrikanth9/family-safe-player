// Language filter: read an .srt / .vtt subtitle file and mute the lines with profanity.

import { newId, mergeSegments, type Segment } from './segments'

export interface Cue {
  start: number
  end: number
  text: string
}

const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})|(\d{1,2}):(\d{2})[,.](\d{1,3})/

function toSec(m: RegExpMatchArray): number {
  if (m[1] !== undefined) return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, '0') / 1000
  return +m[5] * 60 + +m[6] + +m[7].padEnd(3, '0') / 1000
}

/** Parses SRT and WebVTT. Tolerates Windows line endings, BOM, cue settings and missing indices. */
export function parseSubtitles(text: string): Cue[] {
  const blocks = text.replace(/^﻿/, '').replace(/\r/g, '').split(/\n{2,}/)
  const cues: Cue[] = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const i = lines.findIndex((l) => l.includes('-->'))
    if (i === -1) continue
    const [a, b] = lines[i].split('-->')
    const ma = a.match(TIME)
    const mb = b.match(TIME)
    if (!ma || !mb) continue
    const body = lines
      .slice(i + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '') // <i>, <font>, vtt voice tags
      .replace(/\{[^}]+\}/g, '') // ASS-style overrides sometimes left in SRT
      .trim()
    if (body) cues.push({ start: toSec(ma), end: toSec(mb), text: body })
  }
  return cues
}

// Kept deliberately short and unambiguous: words that are almost never innocent.
// Matching is whole-word, with common suffixes, so "class" or "Scunthorpe" don't trigger.
const STRONG = [
  'fuck', 'fucking', 'fucker', 'fucked', 'motherfucker', 'motherfucking', 'shit', 'shitty', 'bullshit',
  'bitch', 'bitches', 'cunt', 'dick', 'dickhead', 'cock', 'cocksucker', 'pussy', 'asshole', 'bastard',
  'whore', 'slut', 'twat', 'wanker', 'prick',
]
const MILD = ['damn', 'goddamn', 'hell', 'ass', 'crap', 'piss', 'pissed', 'bloody']

export type LanguageLevel = 'strong' | 'all'

export function profanityRegex(level: LanguageLevel, extra: string[] = []): RegExp {
  const words = [...STRONG, ...(level === 'all' ? MILD : []), ...extra.map((w) => w.trim().toLowerCase()).filter(Boolean)]
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\b(?:${escaped.join('|')})(?:s|es|ing|ed|er)?\\b`, 'i')
}

/**
 * Mute segments for cues containing profanity. Mutes the whole cue (subtitle timing
 * isn't word-accurate) with a small margin, and merges cues that are close together.
 */
export function languageSegments(cues: Cue[], level: LanguageLevel, extra: string[] = [], margin = 0.15): Segment[] {
  const re = profanityRegex(level, extra)
  const segs: Segment[] = cues
    .filter((c) => re.test(c.text))
    .map((c) => ({
      id: newId('lang'),
      start: Math.max(0, c.start - margin),
      end: c.end + margin,
      category: 'language' as const,
      action: 'mute' as const,
      enabled: true,
      peak: 1,
      note: censor(c.text, re),
    }))
  return mergeSegments(segs, 0.3)
}

/** "What the f*** is this" — shown in the review list instead of the raw line. */
export function censor(text: string, re: RegExp): string {
  const g = new RegExp(re.source, 'gi')
  return text.replace(g, (w) => w[0] + '*'.repeat(Math.max(2, w.length - 1)))
}
