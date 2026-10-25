// Copies the TensorFlow.js WebAssembly binaries into public/ so GitHub Pages can serve them.
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
const src = 'node_modules/@tensorflow/tfjs-backend-wasm/dist/'
const dst = 'public/tfjs-wasm/'
mkdirSync(dst, { recursive: true })
for (const f of readdirSync(src).filter((f) => f.endsWith('.wasm'))) cpSync(src + f, dst + f)
