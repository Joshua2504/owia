# UI-Verbesserungen: erster Umfang

Stand: 06.10.2026. Umsetzung in der Entwicklungsbasis, kein Deployment.
Ausgangspunkt: [UI-Plan](UI-PLAN-2026-10-06.md).

## Umgesetzt

- Suche und Statusfilter in Dashboard und Import-Ergebnis. „Sichtbare Entwürfe
  auswählen“ ist auf Handys außerhalb des ausgeblendeten Tabellenkopfs erreichbar.
  Filterwechsel entfernt versteckte Entwürfe aus der Auswahl.
- Ausgewählte Anzeigen sind markiert. Eine feste Aktionsleiste zeigt Anzahl,
  gemeinsame Bearbeitung, Auswahl aufheben und Löschen mit der vorhandenen
  serverseitigen Bestätigung. Abstand zum Listenende folgt der tatsächlichen
  Höhe der Leiste; Touchflächen und Safe-Area werden berücksichtigt.
- Bis zu 50 Entwürfe gemeinsam bearbeiten: Verstoßart unverändert lassen,
  setzen oder leeren; Fahrzeug verlassen unverändert lassen, Ja oder Nein.
  Katalogsuche begrenzt die Auswahl auf 100 passende Treffer. Verstoßarten
  werden standardmäßig nur in leeren Feldern ergänzt. Vorhandene Werte können
  ausdrücklich überschrieben oder geleert werden. Die Fahrzeugangabe gilt
  bei gewähltem Ja/Nein ausdrücklich für alle ausgewählten Entwürfe.
- Eine Vorschau zeigt Vorher/Nachher je Entwurf. Sie ist signiert, an den
  Nutzer gebunden und zehn Minuten gültig. Ein App-Neustart macht sie ungültig.
  Beim Speichern werden Eigentümer, Entwurfsstatus, Versandsperre und die
  bisherigen Werte der beiden bearbeiteten Felder atomar erneut geprüft.
  Andere Felder bleiben erhalten. Teilfehler werden pro Anzeige gemeldet;
  fehlgeschlagene Anzeigen bleiben ausgewählt. Erfolgreiche Zeilen werden
  ohne Seitenwechsel vom Server neu gerendert.
- Fotos in den Listen haben „Verschieben“ mit Vorschaufoto, Quell-Aktenzeichen,
  Zielsuche und Option für einen neuen Entwurf. Dieselbe vorhandene Route wird
  für Touch und Drag-and-drop verwendet. Foto-Kacheln und leere Fotozellen
  werden nach dem Verschieben aktualisiert. Die Route lehnt auch Entwürfe mit
  Versandsperre ab. Es wurde kein neuer Datei-Verschiebealgorithmus eingeführt.
- Die Übersichtskarte steht nach der Arbeitsliste und kann eingeklappt werden.

Kein Framework-Wechsel, keine Migration. Wie beim vorhandenen Autosave wird
nach reiner Feldbearbeitung das PDF spätestens bei der Einreichung neu erzeugt.
Keine Sammelfreigabe und kein neuer Versandablauf.

## Prüfungen

- `npm run check`: TypeScript einschließlich Tests, alle Browser-Skripte und
  EJS-Templates erfolgreich.
- `npm test`: 23 erfolgreiche Regressionstests in der isolierten Wegwerf-DB
  und Mailpit. Neue Tests prüfen Standardbehandlung bestehender Angaben,
  explizites Leeren/Überschreiben, fremde Nutzer, Anmeldung, ungültigen Katalog,
  Versandsperren, Statuswechsel, veränderte Vorschauwerte, manipulierte Tokens
  und wiederholtes Speichern.
- Chromium mit 30 synthetischen Anzeigen bei 360, 390, 768 und 1280 px:
  Auswahl, Filter, Dialog, Katalogsuche, Vorschau, Speichern, Aktualisierung
  und Foto-Verschieben erfolgreich; kein Seitenüberlauf. Hell/Dunkel und
  Tastaturfokus im Dialog geprüft. Die Browserprüfung verwendete echte
  EJS-Templates und Browser-Skripte mit simulierten API-Antworten; die echte
  Sammelbearbeitungs-API wurde separat in den Regressionstests geprüft.
- `git diff --check`: erfolgreich.

Nicht geprüft: echte iOS-/Android-Geräte, Safari, kompletter authentifizierter
Browserablauf gegen den Dev-Stack und echter Fototransfer im Browser. Keine
Produktionsdaten, echten E-Mails oder Deployments für Tests verwendet.

## Weitere Pakete

Datums-/Importfilter und Sortierung, frei ausgewählte Prüfreihenfolgen,
Mehrfachzuordnung nicht zugeordneter Importfotos, Sammel-Einreichung,
Upload-Wiederaufnahme sowie weitere Anpassungen am Editor und Adminbereich
bleiben die folgenden Schritte aus dem Plan. Vorhandene Upload- und
Dateitransferlogik wurde in diesem Umfang nicht grundsätzlich umgebaut.
