import { defineConfig } from 'vite'
import { copyFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import react from '@vitejs/plugin-react'

// Serve the exact installed PDF.js worker as an ordinary static module in dev and dist.
const projectRequire = createRequire(import.meta.url)
const pdfVersion: string = projectRequire('pdfjs-dist/package.json').version
const workerFile = resolve('public/pdfjs', `worker-${pdfVersion}.mjs`)
mkdirSync(dirname(workerFile), { recursive: true })
copyFileSync(projectRequire.resolve('pdfjs-dist/legacy/build/pdf.worker.min.mjs'), workerFile)

export default defineConfig({
  plugins: [react()],
})
