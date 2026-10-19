import { createRoot } from 'react-dom/client'
// Brand type, bundled so the face never calls a font CDN. Latin only.
import '@fontsource/oxanium/latin-400.css'
import '@fontsource/oxanium/latin-500.css'
import '@fontsource/oxanium/latin-600.css'
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-400-italic.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import './index.css'
import App from './App.tsx'
import { launchToken } from './lib/token'

// Take the launch token out of the address bar before anything else runs.
launchToken()

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
createRoot(document.getElementById('root')!).render(<App />)
