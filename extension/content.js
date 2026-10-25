/* global FSP, chrome */
// Applies the skip list for the current title to the page's main <video>.
;(() => {
  const isNetflix = location.hostname.endsWith('netflix.com')
  let key = null
  let entry = null // { title, duration, segments }
  let enabled = true
  let video = null
  let weMuted = false
  let userMuted = false
  let markStart = null
  let lastSeekAt = 0
  let frameHandle = 0

  // ---------- UI ----------
  const toast = document.createElement('div')
  toast.className = 'fsp-toast'
  let toastTimer
  function say(text, ms = 2200) {
    toast.textContent = text
    toast.classList.add('show')
    const host = document.fullscreenElement || document.body
    if (toast.parentNode !== host) host.appendChild(toast)
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.remove('show'), ms)
  }

  // ---------- storage ----------
  async function loadEntry() {
    const id = FSP.videoKey(location.href, document.title)
    key = id?.key ?? null
    if (!key) {
      entry = null
      return
    }
    const got = await chrome.storage.local.get([`skips:${key}`, 'settings'])
    entry = got[`skips:${key}`] || null
    enabled = got.settings?.enabled !== false
    if (entry?.segments?.length) say(`Family Safe: ${entry.segments.length} scenes will be filtered`)
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (key && changes[`skips:${key}`]) entry = changes[`skips:${key}`].newValue || null
    if (changes.settings) enabled = changes.settings.newValue?.enabled !== false
  })

  // The popup asks which title is open in this tab.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type === 'FSP_STATUS') {
      const id = FSP.videoKey(location.href, document.title)
      reply({
        key: id?.key ?? null,
        site: id?.site ?? location.hostname,
        title: guessTitle(),
        hasVideo: !!findVideo(),
        time: video?.currentTime ?? null,
        duration: Number.isFinite(video?.duration) ? video.duration : null,
        marking: markStart,
      })
    }
    return false
  })

  function guessTitle() {
    const t = document.title.replace(/\s*[-|–]\s*(Netflix|YouTube|Prime Video|Disney\+|Max).*$/i, '').trim()
    return t || location.hostname
  }

  // ---------- video ----------
  function findVideo() {
    const vids = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0 && v.offsetWidth > 0)
    if (!vids.length) return null
    return vids.sort((a, b) => b.offsetWidth * b.offsetHeight - a.offsetWidth * a.offsetHeight)[0]
  }

  function isAd() {
    // YouTube ads play in the same <video>; their timeline is not the film's.
    return !!document.querySelector('.ad-showing, .ad-interrupting')
  }

  function seek(v, t) {
    const now = performance.now()
    if (now - lastSeekAt < 400) return // the previous seek is still in progress
    lastSeekAt = now
    if (isNetflix) window.postMessage({ type: 'FSP_NETFLIX_SEEK', seconds: t }, '*')
    else v.currentTime = t
  }

  function enforce() {
    const v = video
    if (!v || !entry?.segments?.length || isAd()) return
    const segs = entry.segments
    const t = v.currentTime
    if (!enabled) {
      restoreAudio(v)
      v.classList.remove('fsp-black')
      return
    }
    const target = FSP.skipTarget(segs, t + 0.05) ?? FSP.skipTarget(segs, t)
    if (target != null && target > t) {
      const s = FSP.active(segs, t + 0.05, 'skip') || FSP.active(segs, t, 'skip')
      // Hide the picture until the seek lands, so nothing flashes on screen.
      v.classList.add('fsp-black')
      seek(v, target + 0.05)
      say(`Skipped ${FSP.fmt(target - t)}${s?.category ? ` · ${label(s.category)}` : ''}`)
      return
    }
    const quiet = FSP.active(segs, t, 'mute') || FSP.active(segs, t, 'blackout')
    v.classList.toggle('fsp-black', !!FSP.active(segs, t, 'blackout'))
    if (quiet && !weMuted) {
      userMuted = v.muted
      v.muted = true
      weMuted = true
    } else if (!quiet) {
      restoreAudio(v)
    }
  }

  function restoreAudio(v) {
    if (weMuted) {
      v.muted = userMuted
      weMuted = false
    }
  }

  function label(c) {
    return { nudity: 'nudity', suggestive: 'suggestive scene', language: 'language', custom: 'marked scene' }[c] || 'scene'
  }

  function attach(v) {
    if (video === v) return
    if (video && frameHandle && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(frameHandle)
    video = v
    weMuted = false
    const tick = () => {
      enforce()
      if (video === v) frameHandle = v.requestVideoFrameCallback(tick)
    }
    if ('requestVideoFrameCallback' in v) frameHandle = v.requestVideoFrameCallback(tick)
    v.addEventListener('timeupdate', enforce)
    v.addEventListener('seeked', enforce)
  }

  // ---------- marking while you watch (Alt+Shift+M) ----------
  document.addEventListener(
    'keydown',
    async (e) => {
      if (!(e.altKey && e.shiftKey && e.code === 'KeyM')) return
      if (!video || !key) return say('Family Safe: no video found on this page')
      e.preventDefault()
      e.stopPropagation()
      const t = video.currentTime
      if (markStart == null) {
        markStart = t
        say(`Scene start marked at ${FSP.fmt(t)}. Press Alt+Shift+M again at the end.`, 4000)
        return
      }
      const [a, b] = markStart < t ? [markStart, t] : [t, markStart]
      markStart = null
      if (b - a < 0.5) return say('Scene too short, not saved')
      const cur = entry || { title: guessTitle(), duration: Number.isFinite(video.duration) ? video.duration : null, segments: [] }
      cur.segments = [...cur.segments, { start: Math.max(0, a - 0.5), end: b + 0.5, category: 'custom', action: 'skip' }]
      cur.updatedAt = Date.now()
      await chrome.storage.local.set({ [`skips:${key}`]: cur })
      say(`Saved: ${FSP.fmt(a)}–${FSP.fmt(b)} will be skipped next time`, 3500)
    },
    true,
  )

  // ---------- page lifecycle (these sites are single-page apps) ----------
  let lastHref = ''
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href
      markStart = null
      void loadEntry()
    }
    const v = findVideo()
    if (v) attach(v)
  }, 1000)
})()
