# OWiA – native Apps

Capacitor-Hülle (Android + iOS) um https://owia.net. Aufbau, Konten,
Signierung, Release und bekannte Grenzen: [docs/MOBILE-APPS.md](../docs/MOBILE-APPS.md).
Store-Texte und Datenschutz-Angaben: [store/](store/).

```bash
npm ci
npm run sync            # www/ erzeugen + cap sync (beide Plattformen)
npm run android:debug   # braucht JDK 21 + Android SDK (oder Docker, s. Doku)
npm run ios:open        # nur auf macOS
```
