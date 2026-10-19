/**
 * Optional offline wake word: Picovoice Porcupine, built-in keyword "Jarvis".
 *
 * Only used when PICOVOICE_ACCESS_KEY is set in Jarvis's settings. Porcupine runs in
 * WebAssembly on this Mac; audio never leaves it. It needs Picovoice's model
 * file at public/picovoice/porcupine_params.pv (Apache 2.0, from
 * github.com/Picovoice/porcupine, lib/common); `npm run setup` says how to get
 * it. Picovoice no longer issues free personal keys, so this is optional and
 * every failure here falls back to the keyless path in voice.ts.
 *
 * Loaded with a dynamic import so the Picovoice code is only fetched when a
 * key is present.
 */

export type Porcupine = { stop: () => void }

export const PORCUPINE_MODEL_PATH = '/picovoice/porcupine_params.pv'

export async function startPorcupine(accessKey: string, onDetect: () => void): Promise<Porcupine> {
  const head = await fetch(PORCUPINE_MODEL_PATH, { method: 'HEAD' })
  if (!head.ok || /text\/html/.test(head.headers.get('content-type') ?? '')) {
    throw new Error(`model file missing at public${PORCUPINE_MODEL_PATH}`)
  }
  const { PorcupineWorker, BuiltInKeyword } = await import('@picovoice/porcupine-web')
  const { WebVoiceProcessor } = await import('@picovoice/web-voice-processor')
  const worker = await PorcupineWorker.create(
    accessKey,
    [{ builtin: BuiltInKeyword.Jarvis, sensitivity: 0.6 }],
    () => onDetect(),
    { publicPath: PORCUPINE_MODEL_PATH, forceWrite: false },
  )
  await WebVoiceProcessor.subscribe(worker)
  console.info('[jarvis] Porcupine wake word "Jarvis" is listening (offline)')
  return {
    stop: () => {
      void WebVoiceProcessor.unsubscribe(worker)
        .then(() => worker.release())
        .finally(() => worker.terminate())
    },
  }
}
