# Frankfurt am Main – Notizen zum Online-Formular

Laufende Sammlung: was im Frankfurter Online-Formular (ekom21) fehlt, anders
ist als im Tatbestandskatalog oder beim Versand auffällt.

- Code: `src/services/portalFfm.ts`
- Formularbaum: `tests/fixtures/ekom21-ffm-baum.json`

Neue Einträge oben in der passenden Rubrik ergänzen, jeweils mit Datum.

---

## Fehlende Tatbestände / Stufen

### Linke Fahrbahnseite / linker Seitenstreifen ohne Halten/Parken/„länger als 1 Stunde“ (2026-10-08)

- Katalog: 112040/112041 (Halten), 112042/112043 (Parken), 112044/112045
  (Parken länger als 1 Stunde).
- Formular, Rubrik „Einbahnstraße/linke Fahrbahnseite/linker Seitenstreifen“,
  bietet nur:
  - in der Einbahnstraße entgegen der Fahrtrichtung
  - verbotswidrig auf der linken Fahrbahnseite
  - verbotswidrig auf dem linken Seitenstreifen
- Es gibt keine Unterscheidung nach Halten, Parken oder Dauer. Alle sechs TBNR
  landen auf derselben Option (`portalFfm.ts`, Regel ignoriert die Aktion).
- Workaround: Dauer über Tatzeit von–bis bzw. im Freitext angeben.

### Gehweg: „Parken länger als 1 Stunde“ nur für „verbotswidrig auf dem Gehweg“

- Bei den anderen Gehweg-Stellen (Zeichen 239–242.1, Zeichen 315,
  Fußgängerüberweg) gibt es diese Stufe nicht; dort wird „Parken“ gewählt
  (`ohneLang` in `portalFfm.ts`).

## Abweichungen Katalog ↔ Formular

- Einige Stellen gibt es nur als „Parken“ (`nurParken`) oder nur als „Halten“
  (`nurHalten`, z. B. Schutzstreifen); Details in `REGELN` in `portalFfm.ts`.

## Offene Fragen / To-dos

- _(leer)_
