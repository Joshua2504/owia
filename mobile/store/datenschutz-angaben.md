# Datenschutz-Angaben für die Stores

Grundlage: was die Website tatsächlich speichert (Profil in `/einstellungen`,
Anzeigen, Fotos, Login-Codes) und `https://owia.net/datenschutz`. Die App
selbst speichert nichts außer dem Sitzungs-Cookie der WebView. Kein Tracking,
keine Werbe-IDs, keine Analyse- oder Crash-Dienste. Die gleichen Angaben stehen
maschinenlesbar in `ios/App/App/PrivacyInfo.xcprivacy` – bei Änderungen beide
Stellen nachziehen.

## Apple – App Store Connect → App-Datenschutz

„Erfassen Sie Daten?“ → **Ja**. Für jeden Typ unten gilt: *mit der Identität
verknüpft* = ja, *für Tracking verwendet* = nein, *Zweck* = nur
**App-Funktionalität**.

| Kategorie | Datentyp | Wofür |
|---|---|---|
| Kontaktinformationen | Name | Pflichtangabe der Anzeige gegenüber der Behörde |
| Kontaktinformationen | E-Mail-Adresse | Anmeldung, Benachrichtigungen, Pflichtangabe bei einigen Städten |
| Kontaktinformationen | Telefonnummer | nur wo die Behörde sie verlangt (z. B. Mainz) |
| Kontaktinformationen | Physische Adresse | Pflichtangabe der Anzeige |
| Standort | Genauer Standort | Tatort beim Fotografieren (nur während der Nutzung) |
| Nutzerinhalte | Fotos oder Videos | Beweisfotos (nur Fotos) |
| Nutzerinhalte | Andere Nutzerinhalte | Angaben zur Anzeige (Kennzeichen, Verstoß, Beschreibung) |
| Kennungen | Nutzer-ID | interne Konto-ID |

Nicht erfasst: Gesundheit, Finanzen, Kontakte, Browserverlauf, Suchverlauf,
Käufe, Nutzungsdaten, Diagnosedaten, sensible Daten, Geräte-IDs.

**Weitergabe an Dritte:** Die Anzeige (inkl. Name, Anschrift, Fotos, Tatort)
geht auf Wunsch des Nutzers an die zuständige Behörde. Apple zählt das als
Teil der App-Funktion, eine eigene Angabe gibt es dafür nicht.

## Google Play → App-Inhalte → Datensicherheit

- Werden Daten erhoben oder weitergegeben? **Ja**
- Sind alle Daten bei der Übertragung verschlüsselt? **Ja** (nur HTTPS)
- Können Nutzer die Löschung beantragen? **Ja** – in der App unter
  Einstellungen → „Konto schließen“; außerdem per Mail an support@treudler.net.
  Für das Pflichtfeld „Löschungs-URL“: `https://owia.net/einstellungen`
  (nach Anmeldung) bzw. `https://owia.net/datenschutz`.

| Datentyp (Google) | Erhoben | Weitergegeben | Optional? | Zweck |
|---|---|---|---|---|
| Persönliche Daten → Name | ja | ja, an die Behörde | nein | App-Funktionen |
| Persönliche Daten → E-Mail-Adresse | ja | ja, an die Behörde (je nach Stadt) | nein | App-Funktionen, Kontoverwaltung |
| Persönliche Daten → Adresse | ja | ja, an die Behörde | nein | App-Funktionen |
| Persönliche Daten → Telefonnummer | ja | ja, an die Behörde | ja | App-Funktionen |
| Persönliche Daten → Nutzer-IDs | ja | nein | nein | Kontoverwaltung |
| Standort → Genauer Standort | ja | ja, an die Behörde (als Tatort) | ja | App-Funktionen |
| Fotos und Videos → Fotos | ja | ja, an die Behörde | nein | App-Funktionen |
| App-Aktivitäten → Sonstige nutzergenerierte Inhalte | ja | ja, an die Behörde | nein | App-Funktionen |

„Weitergabe“ im Sinne von Google ist die Übermittlung an die Behörde, die der
Nutzer selbst auslöst. Daten werden nicht verkauft und nicht für Werbung genutzt.

## Berechtigungen (Begründung für die Prüfung)

| Berechtigung | Android | iOS | Begründung |
|---|---|---|---|
| Kamera | `CAMERA` | `NSCameraUsageDescription` | Beweisfotos im Kamera-Modus, QR-Codes von Stickern scannen |
| Standort (genau, nur bei Nutzung) | `ACCESS_FINE_LOCATION` | `NSLocationWhenInUseUsageDescription` | Tatort beim Fotografieren vorbelegen |
| Fotos | – (System-Fotoauswahl) | `NSPhotoLibraryUsageDescription` | vorhandene Fotos hochladen |
| Speicher (nur Android ≤ 9) | `WRITE_EXTERNAL_STORAGE` | – | PDF-Downloads in „Downloads“ |

Kein Hintergrund-Standort, kein Mikrofon, keine Kontakte.
