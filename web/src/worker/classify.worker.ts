/// <reference lib="webworker" />
// Runs the NSFW classifier off the main thread so the page stays responsive during a scan.
// Frames arrive as ImageBitmaps (transferred, not copied) and never leave the device.

import * as tf from '@tensorflow/tfjs'
import { setWasmPaths } from '@tensorflow/tfjs-backend-wasm'
import { load, type NSFWJS, type ModelName } from 'nsfwjs/core'
import { MobileNetV2Model } from 'nsfwjs/models/mobilenet_v2'
import { MobileNetV2MidModel } from 'nsfwjs/models/mobilenet_v2_mid'

// Only the two MobileNet models are bundled; the 30 MB InceptionV3 is left out.
const MODELS = [MobileNetV2Model, MobileNetV2MidModel]

export type WorkerRequest =
  | { type: 'init'; model: ModelName }
  | { type: 'classify'; id: number; bitmap: ImageBitmap }

export type WorkerResponse =
  | { type: 'ready'; backend: string; model: ModelName; loadMs: number }
  | { type: 'result'; id: number; explicit: number; suggestive: number; probs: Record<string, number> }
  | { type: 'error'; id?: number; message: string }

let model: NSFWJS | null = null

// WebAssembly fallback for machines without usable WebGL: roughly 10x faster than plain JS.
// The .wasm files are copied to public/tfjs-wasm/ (see scripts/copy-wasm.mjs).
setWasmPaths(new URL(`${import.meta.env.BASE_URL}tfjs-wasm/`, self.location.origin).href)

async function pickBackend(): Promise<string> {
  for (const b of ['webgl', 'wasm', 'cpu']) {
    try {
      if (await tf.setBackend(b)) {
        await tf.ready()
        return b
      }
    } catch {
      /* try next */
    }
  }
  throw new Error('No TensorFlow.js backend available in this browser.')
}

async function init(name: ModelName) {
  const t0 = performance.now()
  const backend = await pickBackend()
  model?.dispose()
  model = await load(name, { modelDefinitions: MODELS })
  // Warm-up: the first inference compiles shaders and is much slower than the rest.
  const warm = tf.zeros([224, 224, 3]) as tf.Tensor3D
  await model.classify(warm)
  warm.dispose()
  post({ type: 'ready', backend, model: name, loadMs: Math.round(performance.now() - t0) })
}

async function classify(id: number, bitmap: ImageBitmap) {
  if (!model) throw new Error('Model not loaded')
  const img = tf.browser.fromPixels(bitmap)
  bitmap.close()
  try {
    const preds = await model.classify(img, 5)
    const probs: Record<string, number> = {}
    for (const p of preds) probs[p.className] = p.probability
    const explicit = (probs.Porn ?? 0) + (probs.Hentai ?? 0)
    const suggestive = probs.Sexy ?? 0
    post({ type: 'result', id, explicit, suggestive, probs })
  } finally {
    img.dispose()
  }
}

function post(msg: WorkerResponse) {
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    if (msg.type === 'init') await init(msg.model)
    else if (msg.type === 'classify') await classify(msg.id, msg.bitmap)
  } catch (err) {
    post({ type: 'error', id: msg.type === 'classify' ? msg.id : undefined, message: String((err as Error)?.message ?? err) })
  }
}
