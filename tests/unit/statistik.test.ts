// Unit-Tests ohne DB/Docker: Öffentliche Statistik und Analyse.
// Ausführen: npm run test:unit (läuft auch in npm run check und in der CI).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregiere } from '../../src/services/statistik'
import { analysiere } from '../../src/services/analyse'
import { regelsatzEuro } from '../../src/config/verstoss'

test('Statistik summiert Regelsätze je TBNR, Freitext zählt ohne Betrag', () => {
  // Stichproben aus dem KBA-Katalog (resources/bussgelder.csv).
  assert.equal(regelsatzEuro('112454'), 55)
  assert.equal(regelsatzEuro('141312'), 25)
  assert.equal(regelsatzEuro('000000'), null)
  const s = aggregiere([
    { verstoss_art: '112454 – Sie parkten verbotswidrig auf dem Gehweg.', monat: '2026-09', city: 'frankfurt' },
    { verstoss_art: '112454 – Sie parkten verbotswidrig auf dem Gehweg.', monat: '2026-10', city: 'frankfurt' },
    { verstoss_art: '141312 – Sie parkten im absoluten Haltverbot (Zeichen 283).', monat: '2026-10', city: 'frankfurt' },
    { verstoss_art: 'Sonstige Vergehen', monat: '2026-10', city: 'frankfurt' },
  ])
  assert.equal(s.anzahl, 4)
  assert.equal(s.mitRegelsatz, 3)
  assert.equal(s.euro, 135)
  assert.deepEqual(s.tatbestaende.map((t) => [t.key, t.anzahl, t.euro]), [['112454', 2, 110], ['141312', 1, 25], ['sonstige', 1, 0]])
  assert.deepEqual(s.monate.map((m) => [m.label, m.anzahl, m.euro]), [['September 2026', 1, 55], ['Oktober 2026', 3, 80]])
})

test('Analyse: Wiederholer-Ranking öffentlich ohne Kennzeichen und nur monatsgenau', () => {
  const r = (kennzeichen: string, tattag: string, stunde: number | null = 8) => ({
    kennzeichen, tattag, stunde, fahrzeug_marke: 'VW', fahrzeug_typ: null, fahrzeug_farbe: 'rot',
    verstoss_art: '112454 – Sie parkten verbotswidrig auf dem Gehweg.', city: 'frankfurt',
    behinderung: 0, fahrzeug_verlassen: 0, tatort: 'Musterstr. 1',
  })
  const rows = [r('F-AB 1', '2026-09-01'), r('FAB1', '2026-09-02'), r('F-AB 1', '2026-09-02'),
    r('F-XY 2', '2026-09-03'), r('F-XY 2', '2026-09-03'), r('F-ZZ 3', '2026-09-07', null)]
  const pub = analysiere(rows)
  assert.equal(pub.fahrzeuge, 3)
  assert.equal(pub.wiederholer, 2)
  assert.deepEqual(pub.ranking.map((w) => [w.name, w.anzahl, w.tage]), [['Fahrzeug 1', 3, 2], ['Fahrzeug 2', 2, 1]])
  const json = JSON.stringify(pub)
  assert.ok(!json.includes('AB1') && !json.includes('Musterstr') && !json.includes('2026-09-0'))
  assert.equal(pub.heatmap[1][8], 1) // 01.09.2026 = Dienstag (Mo = Index 0)
  assert.equal(pub.heatmap[2][8], 2)
  assert.equal(pub.wochentage[0].anzahl, 1) // Montag ohne Uhrzeit zählt nur hier
  const adm = analysiere(rows, { mitKennzeichen: true })
  assert.equal(adm.ranking[0].name, 'F-AB 1') // gespeicherte Schreibweise, nicht die Gruppier-Form
  assert.equal(adm.ranking[0].vergehen[0].tatort, 'Musterstr. 1')
})
