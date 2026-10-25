// Runs in the page's own JavaScript world on Netflix.
// Netflix's player rejects direct video.currentTime changes (error M7375), so seeks go
// through its internal player API. The content script asks for a seek via postMessage.
;(() => {
  function player() {
    const vp = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer
    if (!vp) return null
    const ids = vp.getAllPlayerSessionIds?.() || []
    const id = ids.find((s) => s.startsWith('watch')) || ids[0]
    return id ? vp.getVideoPlayerBySessionId(id) : null
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.type !== 'FSP_NETFLIX_SEEK') return
    let ok = false
    try {
      const p = player()
      if (p) {
        p.seek(Math.round(e.data.seconds * 1000))
        ok = true
      }
    } catch {
      ok = false
    }
    window.postMessage({ type: 'FSP_NETFLIX_SEEK_RESULT', ok }, '*')
  })
})()
