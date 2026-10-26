import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyDocumentLocale } from './lib/i18n'
import {
  applyCustomCss,
  applySmoothAnimations,
  applyTheme,
  getAppSettings,
} from './lib/storage'

const bootSettings = getAppSettings()
applyTheme(bootSettings.theme)
applySmoothAnimations(bootSettings.smoothAnimations)
applyCustomCss(bootSettings.customCss)
applyDocumentLocale(bootSettings.locale)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
