import {
  districtCount,
  detectCityByPlz,
  resolveSendCity,
  cityEmail,
  recipientEmailForReport,
} from './services/districts'
import { CITIES } from './config/cities'

function line(label: string, val: unknown) {
  console.log(label.padEnd(34), typeof val === 'string' ? val : JSON.stringify(val))
}

line('districtCount', districtCount())
console.log('--- detectCityByPlz ---')
for (const plz of ['60313', '63628', '80331', '99999']) {
  const d = detectCityByPlz(plz)
  const extra =
    d.status === 'unlocked'
      ? `${d.city.id} / ${d.district.email}`
      : d.status === 'locked'
      ? `${d.district.name} / ${d.district.email}`
      : ''
  line(`  ${plz}`, `${d.status} ${extra}`)
}
console.log('--- cityEmail (from CSV) ---')
line('  frankfurt', cityEmail(CITIES.frankfurt))
line('  badsoden', cityEmail(CITIES.badsoden))
console.log('--- resolveSendCity (gating) ---')
line('  FFM label', resolveSendCity('Zeil 1, 60313 Frankfurt am Main', 'frankfurt'))
line('  BSS label (dropdown=frankfurt)', resolveSendCity('Hauptstr. 1, 63628 Bad Soden-Salmünster', 'frankfurt'))
line('  München (locked)', resolveSendCity('Marienplatz 1, 80331 München', 'frankfurt'))
line('  no-plz + dropdown badsoden', resolveSendCity('Irgendwo ohne PLZ', 'badsoden'))
line('  no-plz + no dropdown', resolveSendCity('Irgendwo ohne PLZ', null))
console.log('--- recipientEmailForReport (send target) ---')
line('  FFM', recipientEmailForReport({ tatort: 'Zeil 1, 60313 Frankfurt am Main', city: 'frankfurt' }))
line('  BSS', recipientEmailForReport({ tatort: 'Hauptstr. 1, 63628 Bad Soden-Salmünster', city: 'badsoden' }))
