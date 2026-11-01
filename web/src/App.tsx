import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelName } from 'nsfwjs'
import { Player, type PlayerHandle } from './components/Player'
import { Timeline } from './components/Timeline'
import { SegmentList } from './components/SegmentList'
import { Filmstrip } from './components/Filmstrip'
import { Scanner, sampleTimes } from './lib/scanner'
import {
  detectSegments,
  newId,
  PRESETS,
  refinementTimes,
  totalFiltered,
  type FrameScore,
  type Segment,
  type Strictness,
} from './lib/segments'
import { formatTime, parseSkipFile, toEDL, toSkipFile } from './lib/formats'
import { languageSegments, parseSubtitles, type LanguageLevel } from './lib/subtitles'

type Phase = 'idle' | 'loading-model' | 'scanning' | 'refining' | 'thumbs' | 'done' | 'error'

interface Saved {
  frames: FrameScore[]
  strictness: Strictness
  manual: Segment[]
  duration: number
}

const DETAIL = {
  fast: { step: 2, label: 'Fast', hint: 'every 2 s' },
  balanced: { step: 1, label: 'Balanced', hint: 'every second' },
  thorough: { step: 0.5, label: 'Thorough', hint: 'twice a second' },
} as const
type Detail = keyof typeof DETAIL

const MODELS: Record<string, { name: ModelName; label: string; hint: string }> = {
  accurate: { name: 'MobileNetV2Mid', label: 'Accurate', hint: '5.6 MB download' },
  fast: { name: 'MobileNetV2', label: 'Lighter', hint: '3.5 MB, for older laptops' },
}

const storageKey = (f: File) => `fsp:v1:${f.name}:${f.size}`
const BASE = import.meta.env.BASE_URL

export default function App() {
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [duration, setDuration] = useState(0)
  const [frames, setFrames] = useState<FrameScore[]>([])
  const [strictness, setStrictness] = useState<Strictness>('standard')
  const [detail, setDetail] = useState<Detail>('balanced')
  const [modelKey, setModelKey] = useState<keyof typeof MODELS>('accurate')
  const [auto, setAuto] = useState<Segment[]>([])
  const [manual, setManual] = useState<Segment[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0, eta: null as number | null })
  const [error, setError] = useState<string | null>(null)
  const [backend, setBackend] = useState('')
  const [imported, setImported] = useState(false)
  const [restored, setRestored] = useState(false)
  const [current, setCurrent] = useState(0)
  const [tab, setTab] = useState<'scan' | 'scenes' | 'language' | 'export'>('scan')
  const [markStart, setMarkStart] = useState<number | null>(null)
  const [langLevel, setLangLevel] = useState<LanguageLevel>('strong')
  const [extraWords, setExtraWords] = useState('')
  const [subName, setSubName] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const player = useRef<PlayerHandle>(null)
  const scanner = useRef<Scanner | null>(null)
  const abort = useRef<AbortController | null>(null)

  const preset = PRESETS[strictness]
  const segments = useMemo(() => [...auto, ...manual].sort((a, b) => a.start - b.start), [auto, manual])
  const scanned = phase === 'done' || imported || restored
  const busy = phase === 'loading-model' || phase === 'scanning' || phase === 'refining' || phase === 'thumbs'

  // ---------- opening files ----------

  const reset = useCallback(() => {
    abort.current?.abort()
    scanner.current?.dispose()
    scanner.current = null
    setFrames([])
    setAuto([])
    setManual([])
    setThumbs({})
    setPhase('idle')
    setError(null)
    setImported(false)
    setRestored(false)
    setDuration(0)
    setCurrent(0)
    setMarkStart(null)
    setSubName(null)
    setNotice(null)
    setTab('scan')
  }, [])

  const openVideo = useCallback(
    (f: File) => {
      if (!f.type.startsWith('video/') && !/\.(mp4|m4v|webm|mov|mkv|ogv)$/i.test(f.name)) {
        setError('That does not look like a video file.')
        return
      }
      reset()
      if (url) URL.revokeObjectURL(url)
      setFile(f)
      setUrl(URL.createObjectURL(f))
      setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' '))
      // Restore an earlier scan of the same file, so a film is only ever scanned once.
      try {
        const raw = localStorage.getItem(storageKey(f))
        if (raw) {
          const saved = JSON.parse(raw) as Saved
          setFrames(saved.frames)
          setStrictness(saved.strictness)
          setManual(saved.manual)
          setDuration(saved.duration)
          setRestored(true)
          setTab('scenes')
          setNotice('Restored your earlier scan of this file.')
        }
      } catch {
        /* storage unavailable or corrupt: just scan again */
      }
    },
    [reset, url],
  )

  const openSkipFile = useCallback(async (f: File) => {
    try {
      const parsed = parseSkipFile(await f.text())
      setManual(parsed.segments)
      setAuto([])
      setImported(true)
      setTab('scenes')
      if (duration && parsed.duration && Math.abs(parsed.duration - duration) > 5) {
        setNotice(`Heads up: this skip file was made for a ${formatTime(parsed.duration)} video, this one is ${formatTime(duration)}. Times may be off.`)
      } else {
        setNotice(`Loaded ${parsed.segments.length} scenes from “${parsed.title}”.`)
      }
    } catch (e) {
      setError((e as Error).message)
    }
  }, [duration])

  const openDemo = useCallback(async () => {
    try {
      // WebM for Chrome/Firefox, MP4 (H.264) for Safari.
      const webm = document.createElement('video').canPlayType('video/webm; codecs="vp9, opus"') !== ''
      const [vid, skips] = await Promise.all([
        fetch(`${BASE}demo/demo.${webm ? 'webm' : 'mp4'}`).then((r) => r.blob()),
        fetch(`${BASE}demo/demo.skips.json`).then((r) => r.text()),
      ])
      const f = new File([vid], `Demo clip.${webm ? 'webm' : 'mp4'}`, { type: webm ? 'video/webm' : 'video/mp4' })
      openVideo(f)
      const parsed = parseSkipFile(skips)
      setManual(parsed.segments)
      setImported(true)
      setTab('scenes')
      setNotice('Demo: the coloured “scenes” in this clip are marked in a skip file. Press play and watch them get skipped and muted.')
    } catch {
      setError('Could not load the demo clip.')
    }
  }, [openVideo])

  // ---------- re-detect when strictness changes (no rescan needed) ----------

  useEffect(() => {
    if (!frames.length || !duration) return
    setAuto(detectSegments(frames, { ...preset, duration }))
  }, [frames, preset, duration])

  // ---------- persist ----------

  useEffect(() => {
    if (!file || !frames.length || busy) return
    try {
      const saved: Saved = { frames, strictness, manual, duration }
      localStorage.setItem(storageKey(file), JSON.stringify(saved))
    } catch {
      /* quota exceeded or private mode */
    }
  }, [file, frames, strictness, manual, duration, busy])

  // ---------- scanning ----------

  const startScan = useCallback(async () => {
    if (!url) return
    setError(null)
    setNotice(null)
    setFrames([])
    setAuto([])
    setThumbs({})
    setRestored(false)
    const ctrl = new AbortController()
    abort.current = ctrl
    scanner.current?.dispose()
    const sc = new Scanner(url)
    scanner.current = sc
    try {
      setPhase('loading-model')
      const info = await sc.init(MODELS[modelKey].name)
      setBackend(info.backend)
      setDuration(info.duration)

      const step = DETAIL[detail].step
      const times = sampleTimes(info.duration, step)
      setPhase('scanning')
      const live: FrameScore[] = []
      let lastFlush = 0
      const coarse = await sc.scan(
        times,
        (p) => {
          if (p.last) live.push(p.last)
          setProgress({ done: p.done, total: p.total, eta: p.eta })
          const now = performance.now()
          if (now - lastFlush > 400) {
            lastFlush = now
            setFrames([...live])
          }
        },
        ctrl.signal,
      )
      if (ctrl.signal.aborted) throw new DOMException('cancelled', 'AbortError')

      // Second pass: sample 4x per second around every scene edge.
      const opt = { ...PRESETS[strictness], duration: info.duration }
      const extra = refinementTimes(coarse, opt, step)
      let all = coarse
      if (extra.length) {
        setPhase('refining')
        const fine = await sc.scan(extra, (p) => setProgress({ done: p.done, total: p.total, eta: p.eta }), ctrl.signal)
        all = [...coarse, ...fine].sort((a, b) => a.t - b.t)
      }
      setFrames(all)
      setPhase('thumbs')
      await makeThumbs(sc, detectSegments(all, opt), ctrl.signal)
      setPhase('done')
      setTab('scenes')
    } catch (e) {
      if ((e as Error).name === 'AbortError' || ctrl.signal.aborted) {
        setPhase('idle')
        setFrames([])
        setNotice('Scan cancelled.')
      } else {
        setPhase('error')
        setError((e as Error).message || String(e))
      }
    }
  }, [url, modelKey, detail, strictness])

  const makeThumbs = useCallback(async (sc: Scanner, segs: Segment[], signal?: AbortSignal) => {
    for (const s of segs) {
      if (signal?.aborted || s.peakAt == null) continue
      const k = s.peakAt.toFixed(2)
      try {
        const img = await sc.thumbnail(s.peakAt)
        setThumbs((t) => (t[k] ? t : { ...t, [k]: img }))
      } catch {
        /* thumbnail is optional */
      }
    }
  }, [])

  // New auto segments after a strictness change may need thumbnails.
  useEffect(() => {
    const sc = scanner.current
    if (!sc || busy) return
    const missing = auto.filter((s) => s.peakAt != null && !thumbs[s.peakAt.toFixed(2)])
    if (missing.length) void makeThumbs(sc, missing)
  }, [auto, thumbs, busy, makeThumbs])

  const cancelScan = () => abort.current?.abort()

  // ---------- editing ----------

  const patch = useCallback((id: string, p: Partial<Segment>) => {
    const apply = (list: Segment[]) => list.map((s) => (s.id === id ? { ...s, ...p } : s))
    setAuto(apply)
    setManual(apply)
  }, [])

  const remove = useCallback((id: string) => {
    setAuto((l) => l.filter((s) => s.id !== id))
    setManual((l) => l.filter((s) => s.id !== id))
  }, [])

  const mark = () => {
    const t = player.current?.currentTime() ?? 0
    if (markStart == null) {
      setMarkStart(t)
      return
    }
    const [a, b] = markStart < t ? [markStart, t] : [t, markStart]
    if (b - a >= 0.3) {
      setManual((l) => [
        ...l,
        { id: newId('man'), start: a, end: b, category: 'custom', action: 'skip', enabled: true, peak: 1 },
      ])
      setTab('scenes')
    }
    setMarkStart(null)
  }

  const loadSubs = async (f: File) => {
    try {
      const cues = parseSubtitles(await f.text())
      if (!cues.length) throw new Error('No subtitle lines found. Use an .srt or .vtt file.')
      const words = extraWords.split(',').map((w) => w.trim()).filter(Boolean)
      const lang = languageSegments(cues, langLevel, words)
      setManual((l) => [...l.filter((s) => s.category !== 'language'), ...lang])
      setSubName(`${f.name} · ${cues.length} lines · ${lang.length} muted`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // ---------- export ----------

  const download = (name: string, text: string, type: string) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([text], { type }))
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  const safeName = (title || 'video').replace(/[^\w\- ]+/g, '').trim() || 'video'

  // ---------- render ----------

  const lockMessage =
    phase === 'loading-model'
      ? 'Loading the detection model…'
      : busy
        ? 'Scanning… playback unlocks when the scan is done, so nothing slips through.'
        : 'Scan the video (or load a skip file) to unlock filtered playback.'

  return (
    <div className="app">
      <header className="top">
        <a className="brand" href={BASE}>
          <Logo />
          <span>
            Family Safe Player
            <small>Skip the scenes you would rather not watch with family</small>
          </span>
        </a>
        <nav>
          <a href="#how">How it works</a>
          <a href={`${BASE}family-safe-extension.zip`}>Extension</a>
          <a href="https://github.com/phanisrikanth9/family-safe-player" target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
        <LightsSwitch />
      </header>

      {!url ? (
        <Landing onVideo={openVideo} onDemo={openDemo} error={error} />
      ) : (
        <main className="workspace">
          <section className="stage">
            <div className="stage-title">
              <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" />
              <button type="button" className="ghost" onClick={() => { reset(); setUrl(null); setFile(null) }}>
                Open another
              </button>
            </div>
            <Player
              ref={player}
              url={url}
              segments={segments}
              locked={!scanned}
              lockMessage={lockMessage}
              onTime={setCurrent}
              onDuration={(d) => setDuration((old) => old || d)}
            />
            <Timeline
              duration={duration}
              frames={frames}
              segments={segments}
              suggestiveWeight={preset.suggestiveWeight}
              current={current}
              scannedUpTo={phase === 'scanning' && frames.length ? frames[frames.length - 1].t : undefined}
              onSeek={(t) => player.current?.seek(t)}
            />
            <div className="stage-tools">
              <button type="button" onClick={mark} disabled={!scanned} className={markStart != null ? 'marking' : ''}>
                {markStart == null ? 'Mark a scene: start' : `Mark end (started ${formatTime(markStart)})`}
              </button>
              {markStart != null && (
                <button type="button" className="ghost" onClick={() => setMarkStart(null)}>
                  Cancel mark
                </button>
              )}
              <span className="muted small">
                {segments.filter((s) => s.enabled).length} scenes · {formatTime(totalFiltered(segments))} filtered
              </span>
            </div>
            {notice && (
              <p className="notice" role="status">
                {notice}
                <button type="button" className="x" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
                <button type="button" className="x" onClick={() => setError(null)} aria-label="Dismiss">×</button>
              </p>
            )}
          </section>

          <aside className="panel">
            <div className="tabs" role="tablist">
              {(['scan', 'scenes', 'language', 'export'] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {t === 'scan' ? 'Scan' : t === 'scenes' ? `Scenes (${segments.length})` : t === 'language' ? 'Language' : 'Export'}
                </button>
              ))}
            </div>

            {tab === 'scan' && (
              <div className="tab-body">
                <Field label="How strict?">
                  <Seg
                    value={strictness}
                    onChange={(v) => setStrictness(v as Strictness)}
                    options={[
                      ['strict', 'Strict', 'also swimwear, underwear, heavy kissing'],
                      ['standard', 'Standard', 'nudity and sex scenes'],
                      ['lenient', 'Lenient', 'only clearly explicit'],
                    ]}
                  />
                  {frames.length > 0 && <p className="hint">Changing this re-checks the scan instantly. Scenes you marked or loaded are kept.</p>}
                </Field>
                <Field label="Scan detail">
                  <Seg
                    value={detail}
                    onChange={(v) => setDetail(v as Detail)}
                    disabled={busy}
                    options={Object.entries(DETAIL).map(([k, d]) => [k, d.label, d.hint])}
                  />
                </Field>
                <Field label="Model">
                  <Seg
                    value={modelKey}
                    onChange={(v) => setModelKey(v)}
                    disabled={busy}
                    options={Object.entries(MODELS).map(([k, m]) => [k, m.label, m.hint])}
                  />
                </Field>

                {busy ? (
                  <div className="progress">
                    <div className="progress-label">
                      <span>
                        {phase === 'loading-model' && 'Loading model…'}
                        {phase === 'scanning' && `Scanning ${progress.done} / ${progress.total} frames`}
                        {phase === 'refining' && `Sharpening scene edges ${progress.done} / ${progress.total}`}
                        {phase === 'thumbs' && 'Making previews…'}
                      </span>
                      {progress.eta != null && (phase === 'scanning' || phase === 'refining') && (
                        <span className="muted">{formatTime(progress.eta)} left</span>
                      )}
                    </div>
                    <div className="bar">
                      <div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
                    </div>
                    <button type="button" className="ghost" onClick={cancelScan}>Cancel</button>
                  </div>
                ) : (
                  <button type="button" className="primary wide" onClick={startScan}>
                    {frames.length ? 'Scan again' : 'Scan this video'}
                  </button>
                )}
                {backend && <p className="hint">Running on {backend === 'webgl' ? 'your GPU (WebGL)' : backend === 'wasm' ? 'the CPU with WebAssembly (no GPU found, slower)' : 'plain CPU (very slow, try another browser)'}. The video never leaves this device.</p>}

                <div className="divider">or</div>
                <FilePick accept=".json,application/json" label="Load a skip file" onFile={openSkipFile} />
              </div>
            )}

            {tab === 'scenes' && (
              <div className="tab-body">
                {!scanned && !segments.length ? (
                  <p className="empty">Scan the video first. Flagged scenes will show up here for you to review.</p>
                ) : (
                  <>
                    <p className="hint">
                      Previews are blurred. Use <b>Check the cut</b> to play through a scene edge with the filter on.
                    </p>
                    <SegmentList
                      segments={segments}
                      thumbs={thumbs}
                      duration={duration}
                      onChange={patch}
                      onRemove={remove}
                      onJump={(t) => player.current?.seek(t)}
                      onCheck={(s) => player.current?.seek(Math.max(0, s.start - 3), true)}
                    />
                  </>
                )}
              </div>
            )}

            {tab === 'language' && (
              <div className="tab-body">
                <p>Load the film’s subtitle file and every line with swearing is muted.</p>
                <Field label="Mute">
                  <Seg
                    value={langLevel}
                    onChange={(v) => setLangLevel(v as LanguageLevel)}
                    options={[
                      ['strong', 'Strong words', 'f-word, s-word…'],
                      ['all', 'Everything', 'also damn, hell…'],
                    ]}
                  />
                </Field>
                <Field label="Extra words (comma separated)">
                  <input value={extraWords} onChange={(e) => setExtraWords(e.target.value)} placeholder="e.g. jesus, oh my god" />
                </Field>
                <FilePick accept=".srt,.vtt,text/vtt" label="Load subtitles (.srt / .vtt)" onFile={loadSubs} />
                {subName && <p className="hint">{subName}</p>}
              </div>
            )}

            {tab === 'export' && (
              <div className="tab-body">
                <p>Save the scene list to reuse it, share it, or use it while streaming.</p>
                <button
                  type="button"
                  className="primary wide"
                  disabled={!segments.length}
                  onClick={() => download(`${safeName}.skips.json`, JSON.stringify(toSkipFile(title, duration || null, segments), null, 2), 'application/json')}
                >
                  Download skip file (.json)
                </button>
                <p className="hint">
                  Works with this player and the <a href={`${BASE}family-safe-extension.zip`}>Family Safe browser extension</a> (Netflix,
                  Prime Video, Disney+, YouTube).
                </p>
                <button
                  type="button"
                  className="wide"
                  disabled={!segments.length}
                  onClick={() => download(`${safeName}.edl`, toEDL(segments), 'text/plain')}
                >
                  Download for Kodi / MPlayer (.edl)
                </button>
                <p className="hint">Put the .edl next to the video file with the same name. Kodi skips and mutes automatically.</p>
              </div>
            )}
          </aside>
        </main>
      )}

      <HowItWorks />
      <footer className="foot">
        Built by <a href="https://phanisrikanth9.github.io/Phani-Portfolio/">Phani Srikanth Samayam</a>. Detection runs fully in your
        browser; no video, frame or result is uploaded anywhere.
      </footer>
    </div>
  )
}

// ---------- small components ----------

function Landing({ onVideo, onDemo, error }: { onVideo: (f: File) => void; onDemo: () => void; error: string | null }) {
  const [drag, setDrag] = useState(false)
  return (
    <main className="landing">
      <div className="beam" aria-hidden />
      <section className="hero">
        <h1 className="marquee">
          Family movie night,
          <br />
          minus the awkward minutes
        </h1>
        <p className="lead">
          Open a film and an AI model watches it first, right here in your browser. It finds the nudity and sex scenes,
          then plays the movie with them skipped. Nothing is uploaded.
        </p>
        <div className="hero-actions">
          <label
            className={`drop ${drag ? 'drag' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              const f = e.dataTransfer.files[0]
              if (f) onVideo(f)
            }}
          >
            <input type="file" accept="video/*,.mkv" onChange={(e) => e.target.files?.[0] && onVideo(e.target.files[0])} />
            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden>
              <path d="M4 5h16v14H4z M4 9h16 M8 5v4 M12 5v4 M16 5v4" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            <span>
              <strong>Open a movie</strong>
              <small>or drop an MP4 / WebM file here</small>
            </span>
          </label>
          <button type="button" className="ghost-lg" onClick={onDemo}>
            Watch the 50-second demo
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      <Filmstrip />

      <section className="claims" aria-label="What makes it different">
        <p>
          <b>Private by design.</b> The model runs on your own graphics card with TensorFlow.js. The film never leaves your
          computer.
        </p>
        <p>
          <b>You have the final say.</b> Every flagged scene is listed with a blurred preview. Keep it, trim its edges, or mark
          one the model missed.
        </p>
        <p>
          <b>Works on Netflix too.</b> The browser extension applies the same skip list on Netflix, Prime Video, Disney+ and
          YouTube.
        </p>
      </section>
    </main>
  )
}

function HowItWorks() {
  return (
    <section id="how" className="how">
      <h2>How it works</h2>
      <ol>
        <li>
          <b>Sample.</b> The video is seeked frame by frame in a hidden player (every 0.5–2 s), and each frame is shrunk to
          224×224.
        </li>
        <li>
          <b>Classify.</b> A MobileNetV2 image classifier (NSFWJS) runs in a Web Worker on the GPU and scores each frame for
          explicit and suggestive content.
        </li>
        <li>
          <b>Find scenes.</b> Scores are turned into scenes with hysteresis thresholds (a scene opens on a high score and
          stays open until the score clearly drops), then short blips are dropped and nearby scenes merged.
        </li>
        <li>
          <b>Sharpen edges.</b> A second pass samples 4× per second around each scene boundary, so cuts land within about
          a quarter second.
        </li>
        <li>
          <b>Play filtered.</b> The player checks every rendered frame and jumps past skip scenes before they appear, or
          mutes / blacks out depending on your choice.
        </li>
      </ol>
      <h3>Streaming with the extension</h3>
      <p>
        Download <a href={`${BASE}family-safe-extension.zip`}>family-safe-extension.zip</a>, unzip it, open <code>chrome://extensions</code>,
        turn on Developer mode and click <i>Load unpacked</i>. Then either load a skip file made here, or press{' '}
        <b>Alt + Shift + M</b> at the start and end of a scene while you preview the film alone. Next time it is skipped.
      </p>
      <h3>Limits, honestly</h3>
      <ul>
        <li>The model judges single frames. It can miss scenes that are implied (dark rooms, close-ups of faces) and can flag beach or gym scenes. Review the list before family night.</li>
        <li>Streaming services encrypt their video, so the browser cannot read the frames. For Netflix and others, the extension applies a skip file made here from your own copy, or one you mark while watching.</li>
        <li>Skipping during private playback is allowed in the US under the Family Movie Act of 2005. This tool never creates or shares an edited copy of the film.</li>
      </ul>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
    </div>
  )
}

function Seg({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: (readonly [string, string, string])[] | [string, string, string][]
  disabled?: boolean
}) {
  return (
    <div className="seg-ctl" role="radiogroup">
      {options.map(([k, label, hint]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          className={value === k ? 'on' : ''}
          disabled={disabled}
          onClick={() => onChange(k)}
        >
          <span>{label}</span>
          <small>{hint}</small>
        </button>
      ))}
    </div>
  )
}

function FilePick({ accept, label, onFile }: { accept: string; label: string; onFile: (f: File) => void }) {
  return (
    <label className="file-pick">
      <input
        type="file"
        accept={accept}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ''
        }}
      />
      {label}
    </label>
  )
}

/** House lights: 'down' is the dark cinema theme, 'up' the daytime one. */
function LightsSwitch() {
  const [lights, setLights] = useState<'down' | 'up'>(() => (document.documentElement.dataset.theme === 'up' ? 'up' : 'down'))
  const flip = () => {
    const next = lights === 'down' ? 'up' : 'down'
    const apply = () => {
      document.documentElement.dataset.theme = next
      try {
        localStorage.setItem('fsp-lights', next)
      } catch {
        /* private browsing */
      }
      setLights(next)
    }
    const doc = document as Document & { startViewTransition?: (cb: () => void) => void }
    if (doc.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) doc.startViewTransition(apply)
    else apply()
  }
  return (
    <button type="button" className={`lights ${lights}`} onClick={flip} aria-pressed={lights === 'up'}>
      <span className="bulb" aria-hidden />
      {lights === 'down' ? 'Lights up' : 'Lights down'}
    </button>
  )
}

function Logo() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden>
      <rect x="1" y="1" width="32" height="32" rx="9" fill="var(--accent)" />
      <path d="M12 10.5v13l10.5-6.5z" fill="var(--bg)" />
    </svg>
  )
}
