// Unit-Tests ohne DB/Docker: Konfiguration: Städte-Gate, Mail-Fail-Fast.
// Ausführen: npm run test:unit (läuft auch in npm run check und in der CI).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveSendCity } from '../../src/services/districts'
import { assertProductionMailConfig } from '../../src/config/mail'

test('Städte-Gate erkennt Hanau und blockiert nicht freigeschaltete Orte', () => {
  assert.deepEqual(resolveSendCity('Marktplatz, 63450 Hanau', 'frankfurt'), { ok: true, cityId: 'hanau' })
  assert.equal(resolveSendCity('10115 Berlin', 'frankfurt').ok, false)
})

test('Produktions-Mailkonfiguration kann nicht still auf Mailpit zurückfallen', () => {
  assert.throws(() => assertProductionMailConfig({ NODE_ENV: 'production', MAIL_DRIVER: 'smpt' }))
  assert.throws(() => assertProductionMailConfig({ NODE_ENV: 'production', MAIL_DRIVER: 'smtp' }))
  assert.doesNotThrow(() => assertProductionMailConfig({ NODE_ENV: 'development', MAIL_DRIVER: 'mailpit' }))
  assert.doesNotThrow(() => assertProductionMailConfig({ NODE_ENV: 'production', MAIL_DRIVER: 'smtp', MAIL_HOST: 'smtp.example.invalid', MAIL_FROM: 'owia@example.invalid' }))
})
