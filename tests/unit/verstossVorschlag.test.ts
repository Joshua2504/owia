// Unit-Tests ohne DB/Docker: Verstoß-Vorschlag nach Ort.
// Ausführen: npm run test:unit (läuft auch in npm run check und in der CI).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { distanzM, rankeVerstoesse } from '../../src/services/verstossVorschlag'

test('Abstand: 0,001° Breite sind rund 111 m', () => {
  assert.equal(Math.round(distanzM(50.1, 8.68, 50.101, 8.68)), 111)
  assert.equal(distanzM(50.1, 8.68, 50.1, 8.68), 0)
})

test('Nahe Nachbarn schlagen zahlreiche entferntere', () => {
  const r = rankeVerstoesse([
    { verstoss: 'Gehweg', distM: 2 },
    { verstoss: 'Gehweg', distM: 4 },
    { verstoss: 'Linke Seite', distM: 45 },
    { verstoss: 'Linke Seite', distM: 50 },
    { verstoss: 'Linke Seite', distM: 55 },
  ])
  assert.deepEqual(r, [
    { text: 'Gehweg', anzahl: 2 },
    { text: 'Linke Seite', anzahl: 3 },
  ])
})

test('Außerhalb des Radius und ungültige Abstände zählen nicht; höchstens drei', () => {
  assert.deepEqual(rankeVerstoesse([{ verstoss: 'A', distM: 150 }, { verstoss: 'B', distM: Number.NaN }]), [])
  const r = rankeVerstoesse(['A', 'B', 'C', 'D'].map((v, i) => ({ verstoss: v, distM: i })))
  assert.deepEqual(r.map((x) => x.text), ['A', 'B', 'C'])
})
