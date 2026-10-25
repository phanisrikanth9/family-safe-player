// Shared between the content script, popup and options page.
// Storage layout (chrome.storage.local):
//   settings: { enabled: boolean }
//   skips:<videoKey>: { title, duration, segments: [{start,end,category,action,note}], updatedAt }

/* exported FSP */
const FSP = (() => {
  const CATEGORIES = ['nudity', 'suggestive', 'language', 'custom']
  const ACTIONS = ['skip', 'mute', 'blackout']

  /** A stable id for "this title on this site", derived from the URL. */
  function videoKey(href, docTitle = '') {
    let u
    try {
      u = new URL(href)
    } catch {
      return null
    }
    const h = u.hostname
    let m
    if (h.endsWith('netflix.com') && (m = u.pathname.match(/\/watch\/(\d+)/))) return { key: `netflix:${m[1]}`, site: 'Netflix' }
    if (h.endsWith('youtube.com') && u.pathname === '/watch' && u.searchParams.get('v'))
      return { key: `youtube:${u.searchParams.get('v')}`, site: 'YouTube' }
    if (h.endsWith('disneyplus.com') && (m = u.pathname.match(/\/(?:video|play)\/([\w-]+)/))) return { key: `disney:${m[1]}`, site: 'Disney+' }
    if (h.endsWith('max.com') && (m = u.pathname.match(/\/video\/watch\/([\w-]+)/))) return { key: `max:${m[1]}`, site: 'Max' }
    if (h.endsWith('primevideo.com') || h.endsWith('amazon.com')) {
      // Prime's player is an overlay on the detail page, so the title id is the detail page id.
      m = u.pathname.match(/\/(?:detail|dp|gp\/video\/detail)\/([\w]+)/)
      if (m) return { key: `prime:${m[1]}`, site: 'Prime Video' }
      const gti = u.searchParams.get('gti')
      if (gti) return { key: `prime:${gti}`, site: 'Prime Video' }
    }
    if (docTitle) return { key: `${h}:${docTitle.trim().slice(0, 80)}`, site: h }
    return null
  }

  /** Validates a skip file made by the web app. Throws with a readable message. */
  function parseSkipFile(text) {
    let d
    try {
      d = JSON.parse(text)
    } catch {
      throw new Error('Not a valid JSON file.')
    }
    if (!d || d.format !== 'family-safe-skips' || !Array.isArray(d.segments)) throw new Error('This is not a Family Safe skip file.')
    const segments = d.segments.map((s, i) => {
      const start = Number(s.start)
      const end = Number(s.end)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error(`Segment ${i + 1} has invalid times.`)
      return {
        start,
        end,
        category: CATEGORIES.includes(s.category) ? s.category : 'custom',
        action: ACTIONS.includes(s.action) ? s.action : 'skip',
        note: typeof s.note === 'string' ? s.note.slice(0, 200) : undefined,
      }
    })
    return { title: typeof d.title === 'string' ? d.title : 'Untitled', duration: typeof d.duration === 'number' ? d.duration : null, segments }
  }

  function toSkipFile(entry) {
    return {
      format: 'family-safe-skips',
      version: 1,
      title: entry.title,
      duration: entry.duration ?? null,
      createdAt: new Date().toISOString(),
      createdWith: 'Family Safe Player (extension)',
      segments: [...entry.segments].sort((a, b) => a.start - b.start),
    }
  }

  function active(segs, t, action) {
    return segs.find((s) => t >= s.start && t < s.end && (!action || s.action === action))
  }

  /** Where to jump from t, following back-to-back skip segments. */
  function skipTarget(segs, t) {
    let cur = active(segs, t, 'skip')
    if (!cur) return null
    let target = cur.end
    for (let i = 0; i < 50; i++) {
      cur = active(segs, target + 0.01, 'skip')
      if (!cur) break
      target = cur.end
    }
    return target
  }

  function fmt(sec) {
    const s = Math.max(0, Math.floor(sec))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = String(s % 60).padStart(2, '0')
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
  }

  return { videoKey, parseSkipFile, toSkipFile, active, skipTarget, fmt }
})()

if (typeof module !== 'undefined') module.exports = FSP
