// Drives a hidden <video> element through the film, grabs frames and sends them to the worker.
// Seeking and inference are pipelined: while the worker classifies frame N, we seek to frame N+1.

import type { ModelName } from 'nsfwjs'
import type { WorkerRequest, WorkerResponse } from '../worker/classify.worker'
import type { FrameScore } from './segments'

export interface ScanProgress {
  done: number
  total: number
  /** seconds remaining, estimated from the recent rate */
  eta: number | null
  last?: FrameScore
}

const INPUT = 224 // the model's input size

export class Scanner {
  private worker: Worker
  private pending = new Map<number, { resolve: (f: FrameScore) => void; reject: (e: Error) => void; t: number }>()
  private nextId = 1
  private video: HTMLVideoElement
  backend = ''

  constructor(url: string) {
    this.worker = new Worker(new URL('../worker/classify.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.onMessage(e.data)
    this.video = document.createElement('video')
    this.video.muted = true
    this.video.preload = 'auto'
    this.video.playsInline = true
    this.video.src = url
  }

  private readyResolve?: (v: { backend: string; loadMs: number }) => void
  private readyReject?: (e: Error) => void

  private onMessage(msg: WorkerResponse) {
    if (msg.type === 'ready') {
      this.backend = msg.backend
      this.readyResolve?.({ backend: msg.backend, loadMs: msg.loadMs })
    } else if (msg.type === 'result') {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        p.resolve({ t: p.t, explicit: msg.explicit, suggestive: msg.suggestive })
      }
    } else if (msg.type === 'error') {
      if (msg.id != null) {
        const p = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        p?.reject(new Error(msg.message))
      } else {
        this.readyReject?.(new Error(msg.message))
      }
    }
  }

  /** Loads the model in the worker and the video metadata. Returns the video duration. */
  async init(model: ModelName): Promise<{ duration: number; backend: string; loadMs: number }> {
    const ready = new Promise<{ backend: string; loadMs: number }>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.post({ type: 'init', model })
    const meta = waitFor(this.video, 'loadedmetadata', 30000).then(() => {
      if (!Number.isFinite(this.video.duration) || this.video.duration <= 0) {
        throw new Error('This video format is not supported by your browser. Try an MP4 (H.264) or WebM file.')
      }
    })
    const [r] = await Promise.all([ready, meta])
    return { duration: this.video.duration, ...r }
  }

  get duration() {
    return this.video.duration
  }

  /** Classify the frames at the given times. Calls onFrame as results arrive. */
  async scan(
    times: number[],
    onProgress: (p: ScanProgress) => void,
    signal: AbortSignal,
  ): Promise<FrameScore[]> {
    const out: FrameScore[] = []
    const inFlight: Promise<void>[] = []
    const started = performance.now()
    let done = 0

    for (const t of times) {
      if (signal.aborted) break
      const bitmap = await this.grab(t)
      const job = this.classify(t, bitmap).then((f) => {
        out.push(f)
        done += 1
        const elapsed = (performance.now() - started) / 1000
        const rate = done / elapsed
        onProgress({ done, total: times.length, eta: rate > 0 ? (times.length - done) / rate : null, last: f })
      })
      inFlight.push(job)
      // Keep at most 2 frames queued in the worker.
      if (inFlight.length >= 2) await inFlight.shift()
    }
    await Promise.all(inFlight)
    return out.sort((a, b) => a.t - b.t)
  }

  /** Small JPEG of the frame at t, for the review list. */
  async thumbnail(t: number, width = 320): Promise<string> {
    await this.seek(t)
    const v = this.video
    const h = Math.round((width * v.videoHeight) / v.videoWidth) || 180
    const c = document.createElement('canvas')
    c.width = width
    c.height = h
    c.getContext('2d')!.drawImage(v, 0, 0, width, h)
    return c.toDataURL('image/jpeg', 0.7)
  }

  dispose() {
    this.worker.terminate()
    this.video.removeAttribute('src')
    this.video.load()
    for (const p of this.pending.values()) p.reject(new Error('Scan cancelled'))
    this.pending.clear()
  }

  private async grab(t: number): Promise<ImageBitmap> {
    await this.seek(t)
    return createImageBitmap(this.video, { resizeWidth: INPUT, resizeHeight: INPUT, resizeQuality: 'medium' })
  }

  private async seek(t: number) {
    const v = this.video
    const target = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.05))
    if (Math.abs(v.currentTime - target) < 0.001 && v.readyState >= 2) return
    const done = waitFor(v, 'seeked', 10000)
    v.currentTime = target
    await done
    // Some browsers fire 'seeked' before the frame is decoded.
    if (v.readyState < 2) await waitFor(v, 'loadeddata', 5000).catch(() => {})
  }

  private classify(t: number, bitmap: ImageBitmap): Promise<FrameScore> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, t })
      this.post({ type: 'classify', id, bitmap }, [bitmap])
    })
  }

  private post(msg: WorkerRequest, transfer: Transferable[] = []) {
    this.worker.postMessage(msg, transfer)
  }
}

function waitFor(el: HTMLMediaElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for the video (${event}).`))
    }, timeoutMs)
    const onErr = () => {
      cleanup()
      reject(new Error('The browser could not decode this video. Try an MP4 (H.264) or WebM file.'))
    }
    const onOk = () => {
      cleanup()
      resolve()
    }
    const cleanup = () => {
      clearTimeout(timer)
      el.removeEventListener(event, onOk)
      el.removeEventListener('error', onErr)
    }
    el.addEventListener(event, onOk, { once: true })
    el.addEventListener('error', onErr, { once: true })
  })
}

/** Evenly spaced sample times from 0 to duration. */
export function sampleTimes(duration: number, step: number): number[] {
  const n = Math.max(1, Math.floor(duration / step))
  return Array.from({ length: n }, (_, i) => Math.round(i * step * 1000) / 1000)
}
