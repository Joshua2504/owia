# Foto-Import: Übertragung und Bildverarbeitung

Stand: 06.10.2026. Änderungen in der Entwicklungsbasis, kein Deployment.

## Ursache und Änderung

Bisher wurden Pakete mit fünf Fotos vollständig nacheinander hochgeladen.
Die nächste Anfrage begann erst nach EXIF-Auswertung, HEIC-Konvertierung,
Dateispeicherung und Vorschauberechnung aller fünf Fotos. JPEG-/PNG-Decoding
und Skalierung liefen synchron im HTTP-Hauptprozess. Das erklärt wiederkehrende
Verarbeitungspausen zwischen Paketen; die konkreten 150 Fotos des Nutzers
wurden nicht untersucht oder als Produktionslasttest hochgeladen.

Jetzt werden die unveränderten Originalbytes sofort in der Batch-Ablage
gespeichert. Der Upload wartet weder auf EXIF noch auf HEIC-Konvertierung,
Decoding oder Thumbnails. Höchstens zwei Multipart-Pakete werden übertragen;
die aufwendige Verarbeitung beginnt erst nach der Übertragung beim Gruppieren.
EXIF-Auswertung, mögliche HEIC-Konvertierung und Vorschauberechnung laufen über
einen wiederverwendbaren Worker-Thread. Er verarbeitet ein Foto gleichzeitig,
damit nicht beliebig viele große Fotos parallel dekodiert werden.
Thumbnail-Aufträge enthalten Dateipfade und halten nicht alle Originalbytes
eines großen Imports im Arbeitsspeicher.

Originalbytes, EXIF-Wanduhrzeiten, bestehende Dateinamen-/Originalkonventionen,
Uploadlimits und Gruppierungsregeln bleiben erhalten. HEIC-Konvertierung muss
weiter vor dem Speichern der verwendbaren Bildfassung erfolgen und kann den
Durchsatz begrenzen. Konstante maximale Netzgeschwindigkeit wird nicht garantiert.

Die Oberfläche unterscheidet übertragene Bytes, gespeicherte Originale und
Serververarbeitung. Ein Timer aktualisiert die Anzeige auch während
Wartezeiten. „100 %“ bezeichnet die übertragenen Bytes; danach steht ausdrücklich
„Vorschaubilder vorbereiten und Fotos gruppieren“. Die Seite muss bis zum Ende
geöffnet bleiben. Während der abschließenden Verarbeitung liefert die aktuelle
HTTP-API keinen Fortschritt pro Vorschaubild.

## Fehler und Nebenläufigkeit

- Nur Netzwerkfehler, HTTP 429 und HTTP 5xx werden einmal nach einer Sekunde
  wiederholt; dauerhafte HTTP-Fehler und abgelaufene Anmeldung nicht.
- Fortschritt zählt die Bytes jedes Pakets separat und zählt Wiederholungen
  nicht doppelt. XHR-Timeout: zehn Minuten je Versuch.
- Gruppierung und Fehlermeldung warten auf beide laufenden Uploadslots.
  Nach einem endgültigen Paketfehler werden keine neuen Pakete gestartet.
- Dateifehler bleiben sichtbar. Bereits gespeicherte Fotos werden dann erst
  über eine ausdrückliche Aktion gruppiert; keine sofortige Weiterleitung, die
  Fehlermeldungen verdeckt. Bereits gespeicherte Fotos bleiben erhalten.
- Dateien über 20 MB werden vorab ausgeschlossen, damit ein solcher Fehler
  nicht weitere Dateien im selben Paket abschneidet.
- Für überlappende Imports desselben Nutzers werden Duplikatprüfung,
  Dateiverarbeitung und INSERT serialisiert. Der aktuelle Betrieb hat einen
  App-Prozess. Das ist kein verteilter Lock und keine globale Eindeutigkeits-
  garantie gegenüber anderen Uploadrouten oder mehreren App-Instanzen.
- Keine neue Hintergrundwarteschlange in der Datenbank, keine Migration,
  kein Versand und keine zusätzliche externe Bildverarbeitung.

## Prüfungen

- `npm run check`: erfolgreich.
- `npm test`: 25 Regressionstests erfolgreich in isolierter DB/Mailpit.
  Neue Prüfungen: Originalbyte-Erhalt, tatsächlicher Thumbnail-Worker,
  ansprechbarer Hauptprozess während der Verarbeitung, Weiterarbeit nach
  ungültigem Bild, konkurrierende identische Multipart-Uploads, Vorschaubilder
  erst bei Abschluss und Ablehnung eines Uploads in einen abgeschlossenen Batch.
- Chromium-Browserprüfung mit 150 synthetischen Dateien und verzögerten
  API-Antworten: 30 Pakete, höchstens zwei gleichzeitig, Gruppierung erst nach
  allen Antworten. Separat geprüft: temporärer HTTP-503-Fehler mit einem Retry,
  HTTP-403-Abbruch ohne Retry und sichtbare Einzeldateifehler vor Gruppierung.
  Diese Browserprüfung simuliert Serverantworten; sie ist kein Benchmark der
  tatsächlichen Verbindung, großer Handyfotos oder HEIC-Konvertierung.
- `git diff --check`: erfolgreich.

Noch offen: Messung mit den tatsächlichen Fotoformaten/-größen auf dem Handy
und im Zielbetrieb. Echte iOS-/Android-Geräte und ein Neustart während eines
Uploads wurden nicht getestet. Keine Produktionsdaten oder echten E-Mails
wurden für Tests verwendet.
