import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { activeSegment, skipTarget, type Segment } from '../lib/segments'
import { formatTime } from '../lib/formats'

export interface PlayerHandle {
  seek: (t: number, play?: boolean) => void
  currentTime: () => number
}

interface Props {
  url: string
  segments: Segment[]
  locked: boolean
  lockMessage: string
  onTime?: (t: number) => void
  onDuration?: (d: number) => void
}

const LABEL: Record<Segment['category'], string> = {
  nudity: 'nudity',
  suggestive: 'suggestive scene',
  language: 'language',
  custom: 'marked scene',
}

/**
 * <video> with the filter enforced on every rendered frame (requestVideoFrameCallback),
 * not just on 'timeupdate', which only fires about 4 times a second.
 */
export const Player = forwardRef<PlayerHandle, Props>(function Player(
  { url, segments, locked, lockMessage, onTime, onDuration },
  ref,
) {
  const video = useRef<HTMLVideoElement>(null)
  const [filterOn, setFilterOn] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [blackout, setBlackout] = useState(false)
  const segsRef = useRef(segments)
  const filterRef = useRef(filterOn)
  const cbRef = useRef({ onTime, onDuration })
  segsRef.current = segments
  filterRef.current = filterOn
  cbRef.current = { onTime, onDuration }

  useImperativeHandle(ref, () => ({
    seek: (t, play) => {
      const v = video.current
      if (!v) return
      v.currentTime = t
      if (play) void v.play().catch(() => {})
    },
    currentTime: () => video.current?.currentTime ?? 0,
  }))

  useEffect(() => {
    const v = video.current
    if (!v) return
    let handle = 0
    let raf = 0
    let toastTimer: ReturnType<typeof setTimeout> | undefined
    const userMuted = { value: v.muted }
    let weMuted = false

    const enforce = (t: number) => {
      cbRef.current.onTime?.(t)
      const segs = segsRef.current
      if (!filterRef.current) {
        if (weMuted) {
          v.muted = userMuted.value
          weMuted = false
        }
        setBlackout(false)
        return
      }
      // Look slightly ahead so a skip lands before the first frame of the scene is shown.
      const target = skipTarget(segs, t + 0.04) ?? skipTarget(segs, t)
      if (target != null && target > t) {
        const s = activeSegment(segs, t + 0.04, 'skip') ?? activeSegment(segs, t, 'skip')
        v.currentTime = Math.min(target, v.duration || target)
        setToast(`Skipped ${formatTime(target - t)} · ${s ? LABEL[s.category] : 'scene'}`)
        clearTimeout(toastTimer)
        toastTimer = setTimeout(() => setToast(null), 2200)
        return
      }
      const quiet = activeSegment(segs, t, 'mute') ?? activeSegment(segs, t, 'blackout')
      const dark = !!activeSegment(segs, t, 'blackout')
      setBlackout(dark)
      if (quiet && !weMuted) {
        userMuted.value = v.muted
        v.muted = true
        weMuted = true
      } else if (!quiet && weMuted) {
        v.muted = userMuted.value
        weMuted = false
      }
    }

    const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      enforce(meta.mediaTime)
      handle = v.requestVideoFrameCallback(onFrame)
    }
    const loop = () => {
      enforce(v.currentTime)
      raf = requestAnimationFrame(loop)
    }
    if (hasRVFC) handle = v.requestVideoFrameCallback(onFrame)
    else raf = requestAnimationFrame(loop)

    // Also check right after a seek (no frame callback fires while paused on some browsers).
    const onSeeked = () => enforce(v.currentTime)
    const onMeta = () => cbRef.current.onDuration?.(v.duration)
    v.addEventListener('seeked', onSeeked)
    v.addEventListener('loadedmetadata', onMeta)
    return () => {
      if (hasRVFC && handle) v.cancelVideoFrameCallback(handle)
      cancelAnimationFrame(raf)
      clearTimeout(toastTimer)
      v.removeEventListener('seeked', onSeeked)
      v.removeEventListener('loadedmetadata', onMeta)
    }
  }, [url])

  useEffect(() => {
    if (locked) video.current?.pause()
  }, [locked])

  // Ambient light: average the picture every half second and let it spill around the screen.
  const frame = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const v = video.current
    const el = frame.current
    if (!v || !el) return
    const c = document.createElement('canvas')
    c.width = c.height = 8
    const ctx = c.getContext('2d', { willReadFrequently: true })
    const id = window.setInterval(() => {
      if (!ctx || v.paused || v.readyState < 2) return
      try {
        ctx.drawImage(v, 0, 0, 8, 8)
        const d = ctx.getImageData(0, 0, 8, 8).data
        let r = 0, g = 0, b = 0
        for (let i = 0; i < d.length; i += 4) {
          r += d[i]
          g += d[i + 1]
          b += d[i + 2]
        }
        const n = d.length / 4
        el.style.setProperty('--ambient', `rgb(${Math.round(r / n)} ${Math.round(g / n)} ${Math.round(b / n)})`)
      } catch {
        /* cross-origin or not decodable yet */
      }
    }, 500)
    return () => window.clearInterval(id)
  }, [url])

  // House lights dim while the film plays and come back up on pause, like a cinema.
  useEffect(() => {
    const v = video.current
    if (!v) return
    const root = document.documentElement
    let timer: ReturnType<typeof setTimeout> | undefined
    const down = () => {
      clearTimeout(timer)
      // A short delay so scrubbing or "Check the cut" doesn't flicker the room.
      timer = setTimeout(() => root.classList.add('film-playing'), 700)
    }
    const up = () => {
      clearTimeout(timer)
      root.classList.remove('film-playing')
    }
    v.addEventListener('playing', down)
    v.addEventListener('pause', up)
    v.addEventListener('ended', up)
    return () => {
      up()
      v.removeEventListener('playing', down)
      v.removeEventListener('pause', up)
      v.removeEventListener('ended', up)
    }
  }, [url])

  const active = segments.filter((s) => s.enabled).length

  return (
    <div className="player">
      <div className="player-frame" ref={frame}>
        <video
          ref={video}
          src={url}
          controls={!locked}
          playsInline
          style={{ filter: blackout ? 'brightness(0)' : undefined }}
        />
        {locked && (
          <div className="player-lock">
            <p>{lockMessage}</p>
          </div>
        )}
        {toast && <div className="player-toast" role="status">{toast}</div>}
      </div>
      <div className="player-bar">
        <label className="switch">
          <input type="checkbox" checked={filterOn} onChange={(e) => setFilterOn(e.target.checked)} />
          <span className="switch-track" aria-hidden />
          <span>
            Filter {filterOn ? 'on' : 'off'}
            <span className="muted"> · {active} scene{active === 1 ? '' : 's'}</span>
          </span>
        </label>
        {!filterOn && <span className="warn-chip">Unfiltered playback</span>}
      </div>
    </div>
  )
})
