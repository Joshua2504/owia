# Versandbetrieb und Wiederaufnahme

Stand: 06.10.2026. Gilt ab Migration `0032_report_dispatch.sql`.

## Zustände

`reports.status` bleibt `eingereicht`, bis Mailserver-Annahme und lokaler Abschluss
feststehen. `reports.versand_status` ist die zusätzliche dauerhafte Sperre:

| Wert | Bedeutung | Verhalten |
| --- | --- | --- |
| NULL | Kein offener Versandversuch | Freigabe möglich, sofern eingereicht |
| vorbereitung | Profil, Stadt, PDF und Mail werden vorbereitet | Keine zweite Freigabe/Rücknahme/Ablehnung/Kontoschließung |
| versand | Versuch gespeichert; SMTP läuft oder Ausgang unklar | Niemals automatisch erneut senden |
| angenommen | Amts-Empfänger vom SMTP-Server angenommen | Admin kann nur den DB-Abschluss nachholen, ohne weitere Mail |

Nach Abschluss stehen `status=versendet` und `sent_message_id` fest; die erste
Nachricht wird in derselben Transaktion gespeichert. Temporäre Versanddaten
werden geleert. SMTP-Annahme ist kein Zustell-/Bearbeitungsnachweis des Amts.

## Fehler behandeln

Normale Vorbereitungsfehler geben die Sperre wieder frei. Fehler ab Beginn von
SMTP bleiben gesperrt, auch wenn die Fehlermeldung eine Ablehnung nahelegt: Ein
Timeout kann nach erfolgter Annahme eintreten. Eine erneute Freigabe sendet nicht.
`versand_ergebnis` enthält die vorab erzeugte Message-ID sowie Betreff/Text/Absender
für Zuordnung und lokalen Abschluss; diese Inhalte nicht in öffentliche Logs kopieren.

Ein dauerhaftes `vorbereitung` kann nach Prozessabbruch zurückbleiben. `versand`
kann einen laufenden oder unklar beendeten SMTP-Vorgang bedeuten. Nicht allein
anhand des Alters entscheiden, dass eine Wiederholung sicher wäre.

Manuelle Klärung durch den Betreiber:

1. Betroffene App in ein Wartungsfenster nehmen/stoppen und sicherstellen, dass
   kein alter Worker/Prozess noch sendet. Neue Freigaben während der Klärung verhindern.
2. Datensatz und gespeicherte Message-ID gezielt prüfen; bei `versand` anhand der
   SMTP-Protokolle feststellen, ob der Amts-Empfänger den Versuch angenommen hat.
3. Bei bestätigter Annahme ausschließlich diesen Datensatz auf `angenommen`
   setzen, Payload erhalten. Danach App starten und im Adminbereich
   „Abschluss speichern (ohne erneuten Versand)“ ausführen.
4. Nur wenn sicher kein Versand stattgefunden hat (bzw. bei abgebrochener
   `vorbereitung` vor SMTP), Sperre und temporäre Versanddaten dieses Datensatzes
   zurücksetzen. Danach ist eine neue explizite Freigabe möglich.
5. Bleibt der Ausgang unklar, Sperre erhalten und weiter klären. Nie pauschal
   alle Sperren löschen. SQL-Änderungen mit konkreter ID und erwarteter alter
   Zustandsbedingung ausführen und protokollieren.

Kein automatisches „exactly once“ gegenüber einem externen SMTP-Server wird
versprochen. Die Strategie verhindert blinde Wiederholungen und macht unklare
Ergebnisse sichtbar. Benutzer-Nachrichten im bereits vorhandenen Mailverlauf
nutzen noch den bisherigen direkten Versand; die neue Sperre betrifft die
Admin-Freigabe einer Anzeige.

## Portal-Versand (Frankfurt, Wiesbaden, Mainz)

Besonderheiten je Stadt (Adapter in `src/services/portale.ts`):

| Stadt | Formular | Fristen | Besonderes |
|---|---|---|---|
| Frankfurt | ekom21 (`oe=…FFOrdA`) | nur Taten vor heute | Tatbestand-Baum, Variante Pflicht, unbekannte Tatbestände nicht versendbar |
| Wiesbaden | ekom21 (`oe=…WIOrdA`) | max. 2 Monate | eine Ebene, sonst „Sonstiges" + Beschreibung; E-Mail Pflicht; Feld „Ergänzende Angaben" |
| Mainz | civento RLP | – | Art × 11 Rubriken + Freitext, Telefon Pflicht, max. 3 Fotos, Tatort in Feldern |

### Frankfurt (ekom21)

Frankfurt nimmt Anzeigen seit 10/2026 nur noch über das Online-Formular
`portal-civ.ekom21.de` an. Tatbestände, die das Portal nicht anbietet, sind
bewusst nicht versendbar (kein Ausweichen auf Mail). Das Portal nimmt nur Taten
**vor dem heutigen Tag** an – Anzeigen von heute erst ab morgen.
Ablauf unter `/versand` (nur Admins, zwei Läufe parallel):

1. „▶ Senden" sperrt die Anzeige (`versand_status='vorbereitung'`,
   `versand_ergebnis` = `{"portal":{"runId":…}}`) und startet im Container
   `portal` einen Browser-Lauf. Er füllt Schritt für Schritt aus und hält auf
   der Zusammenfassung an.
2. Unklares (Variante fehlt, Tatbestand nicht im Portal, Portal meldet einen
   Fehler) pausiert den Lauf („braucht dich"): im Live-Bild klicken/tippen,
   dann „Fortsetzen".
3. „Jetzt absenden" setzt erst `versand_status='versand'`, dann klickt der
   Dienst auf „Absenden". Ergebnis: `status='versendet'`, `versand_art='portal'`,
   `portal_vorgang_id`, ausgehender Eintrag in `report_replies` mit
   Zusammenfassung (PDF) und Screenshots als Anhängen.
4. Abbrechen vor dem Absenden löst die Sperre, die Anzeige bleibt eingereicht.
5. „Ohne Rückfrage absenden" sendet nur Läufe ab, die ganz ohne Eingriff
   (Pause) durchkamen; alle anderen warten auf den Klick.

**Datenschutz:** Fotos mit erkannten fremden Kennzeichen oder Gesichtern
(`report_images.analyse_json`, ALPR-Container inkl. YuNet-Gesichtserkennung,
`services/dritte.ts`) blockieren Einreichen und Versand, bis sie geschwärzt
(Foto-Dialog „Erkannte schwärzen") oder als unbedenklich bestätigt sind.
Analyse für Bestand nachholen: `npx tsx src/scripts/analyse-nachholen.ts`.

**Selbsttest:** jede Nacht gegen 3 Uhr ein Trockenlauf mit Testdaten bis zur
Zusammenfassung (nie absenden), täglich eine andere Rubrik
(`services/portalSelbsttest.ts`, Job `portal.selbsttest`). Fehlschlag ⇒ Mail an
`ADMIN_EMAILS`; Ergebnis und Knopf „Selbsttest starten" oben auf `/versand`.

Fotos gehen getrennt als Übersichts- und Fahrzeugfoto hoch (je 1–5). Automatisch
gilt ein Foto mit erkanntem Kennzeichen als Fahrzeugfoto; im Foto-Dialog lässt
sich das je Foto festlegen (`report_images.portal_rolle`, Kachel-Kennung Ü/F).

**Unklarer Ausgang** (Fehler nach dem Absenden, Portal-Dienst neu gestartet):
Die Anzeige bleibt mit „Ergebnis unklar" in der Liste. Bestätigungsmail der
Stadt im Postfach des Nutzers prüfen, dann „Wurde versendet" (mit Vorgangs-ID)
oder „Nicht angekommen" (wieder versendbar) klicken – nie blind neu senden.

Läufe leben nur im Speicher des Portal-Dienstes; ekom21 beendet Sitzungen
nach 60 Minuten Inaktivität, der Dienst bricht wartende Läufe nach 40 Minuten ab.
Textfelder: das Portal lehnt Zeichen außerhalb von Latin-1 ab (z.B. „–"),
`portalSafe()` in `docker/portal/ekom21.mjs` ersetzt sie.

## Posteingang

Neue Nachricht und Anhang-Metadaten werden gemeinsam committed, nachdem die
Anhang-Dateien geschrieben wurden. Vorher bleiben sie für andere DB-Verbindungen
unsichtbar. Bei Fehler wird zurückgerollt und IMAP lässt die Mail ungelesen.
Ein späterer Poll kann sie vollständig neu verarbeiten. Duplikate werden erst
nach einem vollständigen Commit übersprungen.

Bei unklarem COMMIT-Ausgang bleiben Dateien erhalten, damit eine eventuell
bereits gespeicherte Nachricht ihre Anhänge nicht verliert. Harte Prozessabbrüche
können verwaiste Dateien hinterlassen; dies ist der Vermeidung von Datenverlust
untergeordnet. Hinweis-Mails bleiben best-effort. Bereits vor dieser Änderung
unvollständig importierte Alt-Mails werden nicht automatisch rekonstruiert.

## Tests

`npm test` startet `compose.test.yml` unter einem eigenen Projektnamen. DB und
Dateien liegen in flüchtigen Dateisystemen, das Netz ist intern, Mailpit nimmt
sämtliche Testmails lokal an. Ein `EXIT`-Trap entfernt Container und Netz.
Keine Tests gegen die laufende Dev-/Produktionsdatenbank ausführen.

## Versand-Takt

Der Portal-Versand (ekom21-Formulare, `portal.start`) startet höchstens **eine
Anzeige alle 10 Minuten** (`services/versandTakt.ts`, Tabelle `versand_takt`).
Der Mail-Versand (`report.dispatch`) ist nicht getaktet. Wartende Jobs stehen mit
„Versand-Takt: nächster Versand frühestens in … min" in `jobs.error` und laufen
automatisch weiter. Ein manueller Start auf `/versand` wird nicht aufgehalten,
zählt aber mit. Neustarts eines verlorenen Portal-Laufs sind ausgenommen.
Abstand per `VERSAND_ABSTAND_SEK` (Default 600) änderbar.
