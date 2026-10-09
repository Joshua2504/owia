import type { CapacitorConfig } from '@capacitor/cli'

// Native Hülle für OWiA (Android + iOS). Die App lädt die Website selbst –
// alle Logik bleibt serverseitig (EJS), Updates kommen ohne Store-Release.
// Der Server erkennt die App am User-Agent-Zusatz „OWiA-App/<plattform>“
// (src/config/mobileApp.ts) und passt Layout und Deep Links an.
//
// OWIA_APP_URL überschreibt das Ziel für Testbuilds, z. B.
//   OWIA_APP_URL=https://dev.owia.net npm run sync
// (Dev hat Basic Auth – das kann die WebView nicht, siehe docs/MOBILE-APPS.md).
const serverUrl = (process.env.OWIA_APP_URL || 'https://owia.net').replace(/\/$/, '')

const config: CapacitorConfig = {
  // Muss zu APP_ID auf dem Server passen (assetlinks.json / apple-app-site-association).
  appId: 'net.owia.app',
  appName: 'OWiA',
  // Nur die Fehlerseite (offline.html) und ein Rückfall-index.html; erzeugt
  // von scripts/prepare-www.mjs.
  webDir: 'www',
  server: {
    url: serverUrl,
    // Start in der Kamera wie bei der PWA (manifest start_url). Ohne Anmeldung
    // leitet /kamera zum Login und danach zurück.
    appStartPath: '/kamera',
    // Lädt eine Seite nicht (offline, Server weg), zeigt die App diese lokale
    // Seite statt einer leeren WebView. Android zeigt sie auch bei HTTP-Fehlern
    // der Hauptseite (4xx/5xx), daher allgemein formuliert.
    errorPath: 'offline.html',
    // Fremde Hosts (z. B. frankfurt.de im Footer) öffnet Capacitor im
    // System-Browser; die App selbst braucht keine weiteren Hosts – Karten
    // kommen über den eigenen /tiles-Proxy.
    allowNavigation: [],
  },
  android: {
    appendUserAgent: 'OWiA-App/android',
    allowMixedContent: false,
    // webContentsDebuggingEnabled bleibt offen: Debug-Builds sind per
    // chrome://inspect bzw. Safari-Entwicklermenü prüfbar, Release-Builds nicht.
  },
  ios: {
    appendUserAgent: 'OWiA-App/ios',
    // Abstände unter Statusleiste/Notch regelt die Website selbst
    // (viewport-fit=cover + env(safe-area-inset-*), public/css/app.css .is-app).
    contentInset: 'never',
    allowsLinkPreview: false,
  },
  plugins: {
    SystemBars: {
      // Android: WebView respektiert viewport-fit=cover, env(safe-area-inset-*) stimmt.
      insetsHandling: 'native',
      initialViewportFitValueHint: 'cover',
    },
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      backgroundColor: '#212529',
      showSpinner: false,
    },
  },
}

export default config
