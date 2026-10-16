// Unit-Tests ohne DB/Docker: Foto-Import: Gruppierung nach Ort/Zeit und Fahrzeug.
// Ausführen: npm run test:unit (läuft auch in npm run check und in der CI).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupPhotos } from '../../src/services/intakeGrouping'

test('Foto-Gruppierung erhält Zeiträume über Mitternacht', () => {
  const result = groupPhotos([
    { id: 1, capturedAt: '2026-10-05 23:55:00', lat: 50.1, lon: 8.6 },
    { id: 2, capturedAt: '2026-10-06 00:05:00', lat: 50.1, lon: 8.6 },
  ])
  assert.equal(result.incidents.length, 1)
  assert.equal(result.incidents[0].dayTo, '2026-10-06')
})

test('Foto-Gruppierung trennt Fahrzeuge am selben Ort nach Kennzeichen', () => {
  const foto = (id: number, zeit: string, plate: string | null, plateConfidence = 1) => ({
    id, capturedAt: `2026-10-14 ${zeit}`, lat: 50.1, lon: 8.6, plate, plateConfidence,
  })
  // Drei Autos nacheinander in derselben Straße (Prod-Fall 515), Übersichtsfoto ohne Lesung.
  const drei = groupPhotos([
    foto(1, '12:07:16', 'GN-BM 1111'), foto(2, '12:07:17', 'GN-BM 1111'), foto(3, '12:07:20', null),
    foto(4, '12:07:34', 'F-MN 435'), foto(5, '12:07:35', 'F-MN 435'),
    foto(6, '12:08:27', 'F-A 123'), foto(7, '12:08:28', 'F-A 123'),
  ])
  assert.deepEqual(drei.incidents.map((i) => i.photoIds), [[1, 2, 3], [4, 5], [6, 7]])
  assert.equal(drei.incidents[1].timeFrom, '12:07:34')
  // OCR-Varianten (Strich, Suffix, ein Zeichen) und ein Auto im Hintergrund bleiben eine Anzeige.
  const eins = groupPhotos([
    foto(1, '15:40:51', 'F-SL 1912'), foto(2, '15:40:55', 'MTK-ZM 555'),
    foto(3, '15:41:01', 'FS-L 1912E'), foto(4, '15:41:03', 'F-SL 1913', 0.8),
  ])
  assert.equal(eins.incidents.length, 1)
  // Ein Foto je Auto: sichere Einzellesungen sind eigene Fahrzeuge, unsichere nicht.
  assert.equal(groupPhotos([foto(1, '10:00:00', 'F-AB 1'), foto(2, '10:00:20', 'F-CD 2')]).incidents.length, 2)
  assert.equal(groupPhotos([foto(1, '10:00:00', 'F-AB 1', 0.88), foto(2, '10:00:20', 'F-CD 2', 0.85)]).incidents.length, 1)
})
