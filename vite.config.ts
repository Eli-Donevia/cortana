import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The bridge port comes from JARVIS_BRIDGE_PORT (shell or .env.local), the
 * same setting the bridge reads, so changing it is one line and a restart.
 * The face's bridge URL and the page's CSP follow it.
 */
function bridgePort(mode: string): number {
  const env = loadEnv(mode, process.cwd(), '')
  const port = Number(env.JARVIS_BRIDGE_PORT || 8787)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8787
}

const cspPort = (port: number): Plugin => ({
  name: 'donevia-csp-bridge-port',
  transformIndexHtml: (html) => (port === 8787 ? html : html.replaceAll(':8787', `:${port}`)),
})

/**
 * transformers.js (inside kokoro-js) loads the ONNX runtime's WASM from
 * jsDelivr, from a folder named after its own version. The CSP allows that
 * one folder, not the whole CDN.
 */
function ortCdn(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('./node_modules/@huggingface/transformers/package.json', import.meta.url), 'utf8'),
  ) as { version: string }
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error(`unexpected transformers version ${pkg.version}`)
  return `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${pkg.version}/dist/`
}

const cspOrt = (): Plugin => ({
  name: 'donevia-csp-ort-cdn',
  transformIndexHtml: (html) => html.replaceAll('__ORT_CDN__', ortCdn()),
})

/**
 * kokoro-js speaks through `phonemizer`, an Emscripten build of espeak-ng.
 * Bundled by Vite's production build it loads with an empty language table
 * (`Invalid language identifier: "en-us". Should be one of: .`), the same
 * failure the dev pre-bundler causes (see optimizeDeps below). So the build
 * leaves it out of the bundle and ships the package's own file unchanged at
 * /vendor/phonemizer-<version>.js, which kokoro's chunk imports directly.
 * Checked in headless Chromium: the raw file phonemizes, the bundled one does
 * not.
 */
function phonemizerFile(): { version: string; path: URL } {
  const dir = new URL('./node_modules/phonemizer/', import.meta.url)
  const { version } = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8')) as { version: string }
  return { version, path: new URL('dist/phonemizer.js', dir) }
}

const rawPhonemizer = (): Plugin => {
  const { version, path } = phonemizerFile()
  const fileName = `vendor/phonemizer-${version}.js`
  return {
    name: 'donevia-raw-phonemizer',
    apply: 'build',
    enforce: 'pre',
    resolveId: (id) => (id === 'phonemizer' ? { id: `/${fileName}`, external: true } : null),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName, source: readFileSync(path) })
    },
  }
}

/**
 * `npm run dev` only: Vite's dev server injects an inline React refresh
 * preamble and talks to its own HMR socket. `npm start` serves the built face
 * (vite build + vite preview), which needs neither, so its CSP has no
 * 'unsafe-inline' script source.
 */
const cspDev = (): Plugin => ({
  name: 'donevia-csp-dev-only',
  apply: 'serve',
  transformIndexHtml: (html) =>
    html
      .replace("script-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'")
      .replace("connect-src 'self'", "connect-src 'self' ws://127.0.0.1:5173"),
})

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const port = bridgePort(mode)
  const explicit = loadEnv(mode, process.cwd(), 'VITE_').VITE_BRIDGE_URL
  return {
    plugins: [react(), cspPort(port), cspOrt(), cspDev(), rawPhonemizer()],
    define: explicit ? {} : { 'import.meta.env.VITE_BRIDGE_URL': JSON.stringify(`ws://127.0.0.1:${port}`) },
    server: {
      // Loopback only: nothing on the network can open the face.
      host: '127.0.0.1',
      // Fixed port: the bridge trusts exactly http://127.0.0.1:5173. If 5173 is
      // taken, `npm run setup` says so instead of the face quietly moving.
      port: 5173,
      strictPort: true,
    },
    // `npm start` serves the built face here, on the same trusted address.
    preview: { host: '127.0.0.1', port: 5173, strictPort: true },
    optimizeDeps: {
      // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
      // Vite's dependency pre-bundler rewrites that initialisation and the
      // language table ends up empty — the symptom is
      // `Invalid language identifier: "en". Should be one of: .` at generate()
      // time, long after the model has loaded successfully. Serving these
      // untouched fixes it.
      exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
    },
  }
})
