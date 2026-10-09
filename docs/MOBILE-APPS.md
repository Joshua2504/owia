# Native Apps (Android & iOS)

Stand 09.10.2026: Alles ist vorbereitet. Es fehlen nur die Entwicklerkonten
und ein macOS-Runner. Android baut auf diesem Server und in GitHub Actions.
iOS ist konfiguriert, aber mangels Mac noch nie gebaut worden.

## Aufbau

```
mobile/
  capacitor.config.ts     App-ID net.owia.app, lädt https://owia.net (Start / wie die PWA)
  scripts/prepare-www.mjs Offline-Seite (www/, erzeugt, nicht im Git)
  scripts/generate-icons.mjs  Icon-/Splash-Quellen → assets/ (dann `npm run assets`)
  android/                Gradle-Projekt (im Git, Build-Ordner nicht)
  ios/App/                Xcode-Projekt mit Swift Package Manager (kein CocoaPods)
  store/                  Store-Texte, Datenschutz-Angaben, Prüfhinweise
.github/workflows/mobile.yml  Builds, Signierung, Upload
```

Die App ist eine **Capacitor-Hülle um die Website**: Sie lädt owia.net in
einer WebView. Neue Funktionen der Website sind deshalb sofort in der App,
ohne Store-Release. Ein neues Release braucht es nur bei Änderungen unter
`mobile/` (Berechtigungen, Icons, native Funktionen).

Was die App anders macht als der Browser:

| Thema | Wo |
|---|---|
| Server erkennt die App am User-Agent `OWiA-App/android\|ios` | `src/config/mobileApp.ts` → `appPlatform`, in `viewData` |
| Layout bis unter Statusleiste/Notch (`viewport-fit=cover`, Klasse `is-app`) | `layout.ejs`, Ende von `public/css/app.css` |
| Universal Links / App Links öffnen die App, auch den Anmeldelink aus der Mail | `src/routes/mobileApp.ts` (`/.well-known/…`), `APP_LINK_PATHS`, AndroidManifest, `App.entitlements` |
| Deep Link in der laufenden App öffnen, Liste nach langer Pause neu laden | `public/js/app-bridge.js` (nur in der App eingebunden) |
| Kamera/Standort: native Berechtigungsabfrage, Kamera-Freigabe ohne zweite Rückfrage | Capacitor, Texte in `Info.plist` |
| PDF-Downloads (Android) | `MainActivity.java`, DownloadManager mit Sitzungs-Cookie |
| Zurück-Wischgeste (iOS) | `MainViewController.swift` |
| Offline-/Fehlerseite | `server.errorPath` → `www/offline.html` |
| Kein Backup des Sitzungs-Cookies (Android) | `allowBackup=false`, `data_extraction_rules.xml` |

Die CSP bleibt unverändert (`script-src 'self'`). Die Capacitor-Brücke wird
nativ eingespritzt (iOS über WKUserScript, Android über
`addDocumentStartJavaScript`), und dafür gilt die CSP nicht. Nur Android-WebViews
älter als Chromium ~90 fielen auf Inline-Injektion zurück. Die Brücke fehlt
dann dort, die Website läuft aber trotzdem.

## Demo-Konto für die Prüfung

Apple und Google brauchen Zugangsdaten. Die Anmeldung läuft aber per Mail-Code.
Deshalb gibt es für **eine** Adresse einen festen Code:

```
APP_REVIEW_EMAIL=appreview@owia.net     # beliebige Adresse, muss kein Postfach haben
APP_REVIEW_CODE=<6 Ziffern>
```

- Dieses Konto kann **nichts einreichen** (`submitDraft`), auch nicht per Admin-Sofortversand.
- Nach 20 falschen Codes ist der feste Code bis zum nächsten Neustart gesperrt.
  Zusätzlich gilt das normale Rate-Limit.
- Ist eine der beiden Variablen leer, ist das Demo-Konto aus.
- Nach der Freigabe in den Stores kann es aus bleiben. Für jedes Update wird es
  wieder gebraucht, weil auch Updates geprüft werden.

## Wenn die Konten da sind

### Apple (developer.apple.com, 99 €/Jahr)

1. **Team-ID** notieren (Membership details).
2. **App-ID** `net.owia.app` mit Capability *Associated Domains* anlegen
   (Certificates, Identifiers & Profiles → Identifiers).
3. In **App Store Connect** eine neue App mit dieser Bundle-ID anlegen. Name,
   Texte und Datenschutz kommen aus `mobile/store/`.
4. **API-Schlüssel** anlegen: Users and Access → Integrations → App Store
   Connect API, Rolle **Admin**. Admin ist nötig, damit Xcode das
   Verteilungszertifikat selbst in der Cloud anlegen darf. Heruntergeladen
   wird eine `.p8`-Datei; dazu Key-ID und Issuer-ID notieren.
5. GitHub-Secrets setzen: `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID` und
   `ASC_KEY_P8_BASE64` (= `base64 -i AuthKey_XXXX.p8`).
6. Prod-`.env`: `APP_IOS_TEAM_ID=<Team-ID>`, dann
   `docker compose up -d --no-build app` (ein `restart` liest die `.env` nicht neu).
   Prüfen: `curl https://owia.net/.well-known/apple-app-site-association`.

### Google (play.google.com/console, einmalig 25 $)

1. **Upload-Schlüssel** erzeugen (nicht im Repo, sicher aufbewahren):
   ```bash
   keytool -genkeypair -v -keystore owia-upload.jks -alias owia-upload \
     -keyalg RSA -keysize 4096 -validity 10000
   ```
2. GitHub-Secrets: `ANDROID_KEYSTORE_BASE64` (= `base64 -w0 owia-upload.jks`),
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (= `owia-upload`), `ANDROID_KEY_PASSWORD`.
3. In der Play Console die App anlegen (Paketname `net.owia.app`). Dann den
   Workflow einmal **ohne Upload** laufen lassen und das AAB aus den Artefakten
   **von Hand** in „Interner Test“ hochladen. Google kennt die App erst nach
   diesem ersten Upload; die API kann ihn nicht ersetzen.
   *Play App Signing* aktiviert sich dabei. Google signiert die App dann mit
   einem eigenen Schlüssel, unser Schlüssel dient nur noch zum Hochladen.
4. **Dienstkonto** für automatische Uploads: Google Cloud → Dienstkonto + JSON-Schlüssel,
   in der Play Console unter Nutzer und Berechtigungen einladen und ihm
   Release-Rechte für die App geben. Das JSON kommt als Secret
   `PLAY_SERVICE_ACCOUNT_JSON` nach GitHub.
5. **App Links:** Play Console → App-Integrität → App-Signatur. Beide
   SHA-256-Fingerprints (App-Signaturschlüssel **und** Upload-Schlüssel)
   kommagetrennt eintragen: Prod-`.env` `APP_ANDROID_SHA256=AA:BB:…,CC:DD:…`,
   danach `up -d --no-build app`. Prüfen:
   `curl https://owia.net/.well-known/assetlinks.json`.
6. Neue **persönliche** Entwicklerkonten (angelegt nach dem 13.11.2023) müssen vor der Produktion
   **14 Tage geschlossen mit mindestens 12 Testern** testen. Diese Zeit gleich
   mit einplanen.

### macOS-Runner

- Variante A: GitHub-gehosteter Runner. Repository-Variable `IOS_ENABLED=true`
  setzen, sonst nichts. Kostet bei privaten Repos das Zehnfache der
  Linux-Minuten.
- Variante B: eigener Mac als Self-hosted Runner (Settings → Actions →
  Runners). Dazu `IOS_ENABLED=true` und `IOS_RUNNER=["self-hosted","macOS"]`
  setzen. Voraussetzungen: aktuelles Xcode mit iOS-SDK (Apple verlangt jeweils
  das aktuelle SDK), Node 22 und eine einmal in Xcode akzeptierte Lizenz
  (`sudo xcodebuild -license accept`). Der Runner sollte in einer angemeldeten
  Benutzersitzung laufen, nicht als System-Dienst.

### Release bauen

GitHub → Actions → „Mobile Apps“ → *Run workflow*: Versionsname angeben und
„Hochladen“ anhaken.

- Android geht dann in den Track `PLAY_TRACK` (Standard `internal`) mit dem
  Status `PLAY_STATUS` (Standard `draft`, solange die App unveröffentlicht ist).
- iOS geht zu TestFlight.
- Die Build-Nummer ist die Lauf-Nummer des Workflows und steigt automatisch.

Ohne Haken entstehen nur die Artefakte: AAB bzw. IPA.

## Lokal testen

Android auf diesem Server (Docker-Image `owia-android-build`, Dockerfile in
`/root/owia/work/android-sdk/`):

```bash
cd mobile && npm ci && npm run sync -- android
docker run --rm -v "$PWD":/w -v /root/owia/work/android-sdk/gradle-cache:/root/.gradle \
  -w /w/android owia-android-build ./gradlew --no-daemon assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

- Ein Debug-APK lässt sich direkt aufs Handy laden. Dazu „Unbekannte Quellen“
  erlauben.
- Debug-Builds kann man per `chrome://inspect` untersuchen, Release-Builds nicht.
- Andere Server-URL: `OWIA_APP_URL=https://… npm run sync`.
- dev.owia.net hat Basic Auth. Die WebView kann damit nicht umgehen; Dev-Tests
  mit der App brauchen deshalb eine Instanz ohne Basic Auth.

iOS: auf einem Mac `cd mobile && npm ci && npm run ios:open`, in Xcode das
Team wählen und auf ein Gerät spielen.

Icons ändern: Neue Quellbilder (1024 px, ohne Transparenz für `icon-only.png`)
nach `mobile/assets/` legen und `npm run assets` ausführen. Die heutigen Bilder
zeigen dasselbe Halteverbot-Schild wie die PWA. Sie stammen aus
`scripts/generate-icons.mjs`.

## Bekannte Grenzen

- **Sticker-Bögen** (`POST /sticker/…/sticker.pdf`): Unter Android kann die
  WebView per POST erzeugte Dateien nicht herunterladen. Bögen am Rechner
  erzeugen. Unter iOS öffnet sich das PDF in der App, zurück geht es per
  Wischgeste.
- **Service Worker** laufen in WKWebView nicht. Das schadet nicht, weil der SW
  nur statische Dateien cacht.
- **Standort unter iOS:** WebKit fragt pro App-Start zusätzlich „owia.net
  möchte deinen Standort verwenden“. Das lässt sich ohne eigenes natives
  Standort-Plugin nicht abstellen.

## Wenn Apple ablehnt (Richtlinie 4.2 „Minimum Functionality“)

Apple lehnt Apps ab, die „nur eine Website verpacken“. Unsere Argumente stehen
in `mobile/store/pruefhinweise.md`. Hilft das nicht, gibt es diese Optionen,
nach Aufwand sortiert:

1. **Teilen-Erweiterung.** Fotos aus der Fotos-App „mit OWiA teilen“, die dann
   im Import landen. Das ist der stärkste Hebel, braucht aber Swift- und
   Kotlin-Code.
2. **Push-Mitteilungen**, wenn die Behörde antwortet oder der Versand durch ist
   (`@capacitor/push-notifications`, APNs/FCM). Dafür braucht es auch
   serverseitig einen Versand.
3. **Nativer Kamera-Modus** mit `@capacitor/camera` und `@capacitor/geolocation`
   statt `getUserMedia`. Erspart nebenbei die doppelte Standort-Rückfrage.

Android/Google Play hat diese Hürde nicht.
