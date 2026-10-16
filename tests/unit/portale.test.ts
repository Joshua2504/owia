// Unit-Tests ohne DB/Docker: Portal-Adapter (Frankfurt, Wiesbaden, Mainz, Hanau, Hamburg).
// Ausführen: npm run test:unit (läuft auch in npm run check und in der CI).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { VERSTOESSE } from '../../src/config/verstoss'
import {
  portalTatbestand, verstossVarianten, langparkerVariante, tatDauerMinuten, photoRoles, portalProblem, buildPortalPayload, portalTatzeit, tatortText, berlinHeute,
} from '../../src/services/portalFfm'
import { portalMarke, fahrzeugBeschreibung } from '../../src/config/fahrzeug'
import { wiTatbestand, wiProblem, buildWiPayload } from '../../src/services/portalWi'
import { buildMzPayload, tatortTeile, mzProblem, mzFotos } from '../../src/services/portalMz'
import { portalFuer, verstossGesperrt, verstossSperren } from '../../src/services/portale'
import { getCityByName } from '../../src/config/cities'

test('Frankfurt-Portal: Tatbestand-Pfade, Varianten und Langparker', () => {
  const pick = (l: string, v?: string) => portalTatbestand(l, v)
  assert.deepEqual(pick('141312 – Sie parkten im absoluten Haltverbot (Zeichen 283).'), {
    gruppe: 'Haltverbot/gesperrter Bereich/Sonderparkplätze',
    pfad: [{ pick: ['im Haltverbot'] }, { pick: ['im absoluten Haltverbot (Zeichen 283)'] }, { pick: ['Parken'] }],
    rettung: false,
    parken: true,
  })
  // Fahrzeug verlassen = Parken, auch bei „Sie hielten …"; der Schutzstreifen
  // kennt im Portal nur Halten.
  const lbl = (tbnr: string) => { const x = VERSTOESSE.find((y) => y.tbnr === tbnr)!; return `${x.tbnr} – ${x.text}` }
  assert.deepEqual(portalTatbestand(lbl('141070'), null, false)!.pfad[0], { pick: ['Halten'] })
  assert.equal(portalTatbestand(lbl('141070'), null, false)!.parken, false)
  assert.deepEqual(portalTatbestand(lbl('141070'), null, true)!.pfad[0], { pick: ['Parken'] })
  assert.equal(portalTatbestand(lbl('141070'), null, true)!.parken, true)
  assert.deepEqual(portalTatbestand(lbl('142170'), null, true)!.pfad[0], { pick: ['Halten'] })
  assert.equal(portalTatbestand(lbl('142170'), null, true)!.parken, false)
  // Bordsteinabsenkung u. Ä.: kein Halten/Parken im Pfad → Zusatz bleibt nötig.
  assert.equal(portalTatbestand(lbl('112372'), null, true)!.parken, false)
  // Mehrdeutig ohne Variante → Live-Auswahl; mit Variante eindeutig.
  const kreuzung = '112262 – Sie parkten weniger als 5 Meter vor der Kreuzung/Einmündung.'
  assert.deepEqual(verstossVarianten(kreuzung).map((x) => x.value), ['Kreuzung', 'Einmündung'])
  assert.ok(pick(kreuzung)!.pfad[0].ask)
  assert.deepEqual(pick(kreuzung, 'Einmündung')!.pfad, [{ pick: ['weniger als 5 Meter VOR einer Einmündung'] }])
  // „länger als 1 Stunde" mit Rückfall auf „Parken"
  assert.deepEqual(pick('112656 – Sie parkten länger als 1 Stunde verbotswidrig auf dem Gehweg.')!.pfad[0], { pick: ['Parken länger als 1 Stunde', 'Parken'] })
  assert.equal(pick('112612 – Sie parkten vor oder in einer amtlich gekennzeichneten Feuerwehrzufahrt und behinderten dadurch ein Rettungsfahrzeug im Einsatz.')!.rettung, true)
  // Nicht im Portal
  assert.equal(pick('112456 – Sie hielten/parkten nicht Platz sparend.'), null)
  assert.equal(langparkerVariante('112454 – Sie parkten verbotswidrig auf dem Gehweg.'), '112656 – Sie parkten länger als 1 Stunde verbotswidrig auf dem Gehweg.')
  assert.equal(tatDauerMinuten({ tatzeit_von: '10:15:00', tatzeit_bis: '11:30:00' }), 75)
  assert.equal(portalProblem({ verstoss_art: kreuzung }), 'Bitte beim Verstoß genauer angeben: Kreuzung oder Einmündung.')
  assert.equal(portalProblem({ verstoss_art: kreuzung, verstoss_variante: 'Kreuzung', kennzeichen_land: 'D' }), null)
})

for (const [stadt, datei] of [['frankfurt', 'ekom21-ffm-baum.json'], ['hanau', 'ekom21-hu-baum.json']] as const) test(`ekom21-Portal ${stadt}: jeder waehlbare Verstoß führt im Portal-Baum zu einem Eintrag`, async () => {
  // tests/fixtures/ekom21-ffm-baum.json: alle Pfade des Online-Formulars (Stand
  // 10/2026, durchgespielt mit /root/owia/work/ekom21-frankfurt/dfs.js); Hanau
  // (14.10.2026, /root/owia/work/hanau/tree.js) hat denselben Baum plus Rubrik
  // „Ohne oder mit abgelaufener Parkscheibe" – das Frankfurter Mapping muss dort
  // genauso aufgehen.
  const baum = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'fixtures', datei), 'utf8')) as Record<string, string[][]>
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase()
  const passt = (opt: string, c: string) => norm(opt).startsWith(norm(c))
  // Spielt den Pfad wie choosePathElement (docker/portal/lib.mjs) durch.
  const fehler = (gruppe: string, pfad: { pick?: string[]; ask?: string[]; optional?: boolean }[]) => {
    let blaetter = baum[gruppe] ?? []
    let tiefe = 0
    for (const el of pfad) {
      const opts = [...new Set(blaetter.filter((p) => p.length > tiefe).map((p) => p[tiefe]))]
      const cands = el.pick ?? el.ask ?? []
      const treffer = el.pick
        ? cands.map((c) => opts.find((o) => passt(o, c))).find(Boolean)
        : (() => { const f = opts.filter((o) => cands.some((c) => passt(o, c))); return f.length === 1 ? f[0] : undefined })()
      if (!treffer) {
        if (el.optional) continue
        return `keine Option für ${cands.join(' / ')} (da: ${opts.join(' / ')})`
      }
      blaetter = blaetter.filter((p) => p[tiefe] === treffer)
      tiefe++
    }
    return blaetter.some((p) => p.length === tiefe) ? null : 'Pfad endet vor einem Eintrag'
  }
  const probleme: string[] = []
  let waehlbar = 0
  for (const x of VERSTOESSE) {
    const label = `${x.tbnr} – ${x.text}`
    if (verstossGesperrt(stadt, label)) continue
    waehlbar++
    const vs = verstossVarianten(label)
    for (const v of vs.length ? vs.map((y) => y.value) : [null]) {
      for (const verlassen of [false, true]) {
        const tb = portalTatbestand(label, v, verlassen)!
        const f = fehler(tb.gruppe, tb.pfad)
        if (f) probleme.push(`${x.tbnr} [${v ?? '-'}${verlassen ? ', verlassen' : ''}]: ${f}`)
      }
    }
  }
  assert.deepEqual(probleme, [])
  assert.ok(waehlbar >= 180, `nur ${waehlbar} waehlbar`)
  // Halten gibt es im Portal nicht überall: absolutes Haltverbot nur „Parken".
  assert.equal(verstossGesperrt(stadt, '141310 – Sie hielten im absoluten Haltverbot (Zeichen 283).'), true)
  assert.equal(verstossGesperrt(stadt, '141312 – Sie parkten im absoluten Haltverbot (Zeichen 283).'), false)
  // Andere Städte sperren nichts.
  assert.equal(verstossGesperrt('wiesbaden', '141310 – Sie hielten im absoluten Haltverbot (Zeichen 283).'), false)
  const sp = verstossSperren(VERSTOESSE.map((x) => `${x.tbnr} – ${x.text}`))
  assert.deepEqual(Object.keys(sp.gesperrt).sort(), ['frankfurt', 'hanau'])
  assert.equal(sp.gesperrt[stadt].idx.length, VERSTOESSE.length - waehlbar)
})

test('Frankfurt-Portal: Fahrzeug, Fotos und Payload', () => {
  const lbl2 = (tbnr: string) => { const x = VERSTOESSE.find((y) => y.tbnr === tbnr)!; return `${x.tbnr} – ${x.text}` }
  assert.equal(portalMarke('VW'), 'Volkswagen')
  assert.equal(portalMarke('Mercedes'), 'Mercedes-Benz')
  assert.equal(portalMarke('vw golf'), 'Volkswagen')
  assert.equal(portalMarke('Lada'), null)
  assert.equal(fahrzeugBeschreibung({ fahrzeug_marke: 'VW', fahrzeug_modell: 'Golf', fahrzeug_farbe: 'schwarz' }), 'VW Golf, schwarz')
  // Die Reihenfolge entscheidet: Foto 1 = Übersicht, der Rest (≤ 5) = Fahrzeug.
  const roles = photoRoles([1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual([roles.uebersicht, roles.fahrzeug], [[1], [2, 3, 4, 5, 6]])
  const one = photoRoles([{ id: 7, detected_plate: null }])
  assert.deepEqual([one.uebersicht.map((i) => i.id), one.fahrzeug.map((i) => i.id)], [[7], [7]])
  const p = buildPortalPayload(
    { verstoss_art: '141174 – Sie parkten auf einem Radweg/Radfahrstreifen (Zeichen 237).', kennzeichen: 'F-AB 1', kennzeichen_land: 'D',
      fahrzeug_marke: 'VW', fahrzeug_farbe: 'rot', tattag: '2026-10-07', tatzeit_von: '22:30:00', tatzeit_bis: '01:00:00', tattag_bis: '2026-10-08',
      tatort: 'Römerberg 1, 60311 Frankfurt am Main', beschreibung: 'Vor dem Café', behinderung: 0 } as any,
    { anrede: 'frau', vorname: 'Erika', nachname: 'Muster', strasse: 'Weg', hausnummer: '2', plz: '60311', ort: 'Frankfurt', email: 'e@x' } as any
  )
  assert.equal(p.person.anrede, 'Frau')
  assert.equal(p.fahrzeug.marke, 'Volkswagen')
  assert.equal(p.fahrzeug.typ, 'PKW')
  assert.deepEqual(p.tat, { ort: 'Römerberg 1 (Tatzeitraum bis 08.10.2026 01:00 Uhr; Vor dem Café)', tattag: '07.10.2026', von: '22:30', bis: '23:59' })
  assert.equal(p.gruppe, 'Radweg/Radfahrstreifen')
  // Ende fehlt: letztes Foto desselben Tages; sonst Beginn = Ende.
  assert.deepEqual(portalTatzeit({ tattag: '2026-09-11', tatzeit_von: '02:13:33' }, '2026-09-11 02:19'), { von: '02:13', bis: '02:19', zusatz: null })
  assert.deepEqual(portalTatzeit({ tattag: '2026-09-11', tatzeit_von: '02:13:33' }, null), { von: '02:13', bis: '02:13', zusatz: null })
  assert.equal(tatortText({ tatort: 'Franz-Simon-Straße 29, 65934 Frankfurt am Main', fahrzeug_verlassen: 1 }), 'Franz-Simon-Straße 29 (Fahrzeug war verlassen)')
  assert.equal(tatortText({ tatort: 'Franz-Simon-Straße 29, 65934 Frankfurt am Main', fahrzeug_verlassen: 1 }, [], true), 'Franz-Simon-Straße 29')
  // Payload: Parken im Pfad → kein Zusatz; Halten-Tatbestand + verlassen → Parken.
  const basis = { kennzeichen: 'F-AB 1', kennzeichen_land: 'D', tattag: '2026-10-07', tatzeit_von: '10:00:00', tatzeit_bis: '10:30:00',
    tatort: 'Römerberg 1, 60311 Frankfurt am Main', behinderung: 0, fahrzeug_verlassen: 1 }
  const nutzer = { anrede: 'herr', vorname: 'M', nachname: 'M', strasse: 'Weg', hausnummer: '1', plz: '60311', ort: 'Frankfurt', email: 'm@x' } as any
  const geparkt = buildPortalPayload({ ...basis, verstoss_art: '141174 – Sie parkten auf einem Radweg/Radfahrstreifen (Zeichen 237).' } as any, nutzer)
  assert.equal(geparkt.tat.ort, 'Römerberg 1')
  const gehalten = buildPortalPayload({ ...basis, verstoss_art: lbl2('141070') } as any, nutzer)
  assert.deepEqual(gehalten.pfad[0], { pick: ['Parken'] })
  assert.equal(gehalten.tat.ort, 'Römerberg 1')
  const schutz = buildPortalPayload({ ...basis, verstoss_art: lbl2('142170') } as any, nutzer)
  assert.equal(schutz.tat.ort, 'Römerberg 1 (Fahrzeug war verlassen)')
  const bordstein = buildPortalPayload({ ...basis, verstoss_art: lbl2('112372') } as any, nutzer)
  assert.equal(bordstein.tat.ort, 'Römerberg 1 (Fahrzeug war verlassen)')
  // Versicherungskennzeichen: Leichtkraftfahrzeug geht als Leichtkraftrad,
  // PKW wird vorher abgefangen (das Portal lehnt das Format sonst ab).
  const ape = { ...basis, verstoss_art: lbl2('141070'), kennzeichen: '705 HNX', fahrzeug_typ: 'Leichtkraftfahrzeug' }
  assert.equal(buildPortalPayload(ape as any, nutzer).fahrzeug.typ, 'Leichtkraftrad')
  assert.equal(buildPortalPayload({ ...ape, kennzeichen: 'F-AB 1' } as any, nutzer).fahrzeug.typ, 'Leichtkraftfahrzeug')
  const kreuz = { verstoss_art: '112262 – Sie parkten weniger als 5 Meter vor der Kreuzung/Einmündung.', verstoss_variante: 'Kreuzung', kennzeichen_land: 'D', kennzeichen: '705 HNX' }
  assert.equal(portalProblem({ ...kreuz, fahrzeug_typ: 'Leichtkraftfahrzeug' }), null)
  assert.equal(portalProblem({ ...kreuz, fahrzeug_typ: 'Mofa' }), null)
  assert.match(portalProblem({ ...kreuz, fahrzeug_typ: 'PKW' }) || '', /Versicherungskennzeichen/)
  assert.equal(portalProblem({ ...kreuz, kennzeichen_land: 'NL', fahrzeug_typ: 'PKW' }), null)
})

test('Wiesbaden- und Mainz-Portal: Zuordnung, Prüfungen, Payload', () => {
  // Wiesbaden: eine Ebene, Halten → Sonstiges
  assert.deepEqual(wiTatbestand('141312 – Sie parkten im absoluten Haltverbot (Zeichen 283).'), { gruppe: 'Haltverbot', satz: ['Das Fahrzeug parkte im absoluten Haltverbot (Zeichen 283)'] })
  assert.equal(wiTatbestand('141310 – Sie hielten im absoluten Haltverbot (Zeichen 283).'), null)
  assert.equal(wiTatbestand('141245 – Sie benutzten die Sperrfläche (Zeichen 298) zum Parken.')!.satz[0], 'Das Fahrzeugt parkte auf einer Sperrfläche')
  const u = { anrede: 'herr', vorname: 'Max', nachname: 'M', strasse: 'Weg', hausnummer: '1', plz: '65183', ort: 'Wiesbaden', email: 'm@x', telefon: '0611 1' } as any
  const wi = buildWiPayload({ verstoss_art: '112456 – Sie hielten/parkten nicht Platz sparend.', kennzeichen_land: 'D', tattag: '2026-10-07', tatzeit_von: '10:00:00', tatort: 'Wilhelmstraße 10, 65183 Wiesbaden', behinderung: 0, fahrzeug_verlassen: 1 } as any, u)
  assert.equal(wi.gruppe, 'Sonstiges')
  assert.deepEqual(wi.pfad, [])
  assert.match(wi.tatvorwurf, /nicht Platz sparend/)
  assert.equal(wi.tat.ort, 'Wilhelmstraße 10')
  assert.match(wi.ergaenzend, /verlassen/)
  assert.equal(wiProblem({ tattag: '2020-01-01' }), 'Wiesbaden nimmt nur Taten der letzten zwei Monate an.')
  // Mainz: Art × Rubrik, Tatort zerlegt, Telefon Pflicht
  assert.deepEqual(tatortTeile('Große Bleiche 12a, 55116 Mainz'), { strasse: 'Große Bleiche', hausnummer: '12a', plz: '55116', ort: 'Mainz' })
  assert.equal(tatortTeile('Rheinufer, 55116 Mainz')!.hausnummer, null)
  const mz = buildMzPayload({ verstoss_art: '112262 – Sie parkten weniger als 5 Meter vor der Kreuzung/Einmündung.', verstoss_variante: 'Einmündung', kennzeichen: 'MZ-A 1', kennzeichen_land: 'D', fahrzeug_marke: 'Skoda', fahrzeug_typ: 'Elektrokleinstfahrzeug', tattag: '2026-10-07', tatzeit_von: '10:00:00', tatort: 'Große Bleiche 12, 55116 Mainz', behinderung: 1, behinderung_text: 'Kinderwagen' } as any, u)
  assert.deepEqual(mz.mz.art, 'Parken')
  assert.equal(mz.mz.rubrik, 'Das Fahrzeug stand im 5-Meter Kreuzungsbereich')
  assert.match(mz.mz.freitext, /genauer: Einmündung.*Behinderung: Kinderwagen/)
  assert.equal(mz.fahrzeug.marke, 'Škoda')
  assert.equal(mz.fahrzeug.typ, 'Elektrokleinstrad')
  assert.equal(mzProblem({ tatort: 'Große Bleiche 12, 55116 Mainz' }, { telefon: '' }), 'Mainz verlangt eine Telefonnummer – bitte im Profil ergänzen.')
  assert.deepEqual(mzFotos({ uebersicht: [1, 2, 3], fahrzeug: [4, 5] }), [4, 1, 5])
  // Registry + Ortsteile
  assert.equal(portalFuer('mainz')!.id, 'civento-mz')
  assert.equal(getCityByName('Mainz-Kastel')!.id, 'wiesbaden')
})

test('Hanau-Portal: Frankfurter Formular, E-Mail Pflicht, heute erlaubt, 2-Monats-Grenze', () => {
  const hu = portalFuer('hanau')!
  assert.equal(hu.id, 'ekom21-hu')
  assert.equal(hu.heuteErlaubt, true)
  const r = { verstoss_art: '112454 – Sie parkten verbotswidrig auf dem Gehweg.', kennzeichen: 'HU-A 1', kennzeichen_land: 'D',
    tattag: '2026-10-07', tatzeit_von: '10:00:00', tatort: 'Am Markt 14, 63450 Hanau', behinderung: 0 } as any
  const u = { anrede: 'herr', vorname: 'Max', nachname: 'Muster', strasse: 'Weg', hausnummer: '2', plz: '63450', ort: 'Hanau', email: 'm@x' } as any
  const p = hu.payload(r, u) as any
  assert.equal(p.portal, 'ekom21-hu')
  assert.equal(p.gruppe, 'Gehweg/Fußgängerüberweg/Fußgängerfurt')
  assert.equal(p.tat.ort, 'Am Markt 14')
  assert.equal(p.email, 'm@x')
  assert.throws(() => hu.payload(r, { ...u, email: '' }), /E-Mail/)
  // Der kalendermäßig entsprechende Tag vor zwei Monaten ist schon zu alt
  // (Portal lehnt am 14.10. den 14.08. ab, nimmt den 15.08.).
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const grenze = new Date(berlinHeute()); grenze.setMonth(grenze.getMonth() - 2)
  const danach = new Date(grenze); danach.setDate(danach.getDate() + 1)
  assert.equal(hu.problem({ ...r, tattag: iso(grenze) }), 'Hanau nimmt nur Taten der letzten zwei Monate an.')
  assert.equal(hu.problem({ ...r, tattag: iso(danach) }), null)
})

test('Hamburg-Portal: Tatvorwürfe, Kennzeichen, Tatort, Payload', async () => {
  const { hhTatbestand, hhKennzeichen, hhTatort, buildHhPayload, hhProblem, hhFotos, HH_TATVORWUERFE } = await import('../../src/services/portalHh')
  const { VERSTOSS_ARTEN } = await import('../../src/config/verstoss')
  const { getCity } = await import('../../src/config/cities')
  // Radio-Tatvorwurf, Listen-Tatvorwurf (Dauer/Behinderung fallen weg), sonst „keiner"
  assert.deepEqual(hhTatbestand('112454 – Sie parkten verbotswidrig auf dem Gehweg.'), { radio: '1', liste: null, text: 'Sie parkten verbotswidrig auf dem Gehweg' })
  assert.equal(hhTatbestand('141324 – Sie parkten unzulässig länger als 1 Stunde im eingeschränkten Haltverbot (Zeichen 286).').liste, '12')
  assert.equal(hhTatbestand('142106 – Sie parkten in einem verkehrsberuhigten Bereich (Zeichen 325.1, 325.2) verbotswidrig außerhalb der zum Parken gekennzeichneten Flächen länger als 3 Stunden.').liste, '7')
  assert.equal(hhTatbestand('141071 – Sie hielten auf einem Radweg/Radfahrstreifen (Zeichen 237) und behinderten dadurch Andere.').liste, '10')
  assert.deepEqual(hhTatbestand('112456 – Sie hielten/parkten nicht Platz sparend.'), { radio: 'keine', liste: '25', text: null })
  // Jeder Formular-Tatvorwurf außer 2 und 23 (kein Katalog-Pendant) hat Katalogeinträge, nichts landet doppelt.
  const treffer = new Map<string, number>()
  for (const l of VERSTOSS_ARTEN) { const t = hhTatbestand(l); const k = t.liste ?? t.radio; treffer.set(k, (treffer.get(k) || 0) + 1) }
  for (const o of HH_TATVORWUERFE) if (!['2', '23'].includes(o.wert)) assert.ok((treffer.get(o.wert) || 0) >= 1, `Tatvorwurf ${o.wert} ohne Katalogtreffer`)
  assert.ok((treffer.get('25') || 0) > 300, 'Rest geht über „keiner" mit Sachverhalt')
  // Kennzeichen im Formular-Format, Mehrdeutiges unverändert
  assert.equal(hhKennzeichen('hh ab 123'), 'HH-AB 123')
  assert.equal(hhKennzeichen('F-OW1234E'), 'F-OW 1234E')
  assert.equal(hhKennzeichen('HHAB123'), 'HHAB123')
  // Tatort: Hausnummer, kreuzende Straße, ohne Nummer; PLZ nur Hamburger
  assert.deepEqual(hhTatort('Hammer Straße 30, 22041 Hamburg'), { strasse: 'Hammer Straße', hausnummer: '30', plz: '22041', angaben: '' })
  assert.deepEqual(hhTatort('Jungfernstieg / Ecke Ballindamm, 20095 Hamburg'), { strasse: 'Jungfernstieg', hausnummer: 'Ballindamm', plz: '20095', angaben: '' })
  assert.equal(hhTatort('Jungfernstieg')!.angaben, 'Angabe laut Anzeige: Jungfernstieg')
  assert.equal(hhTatort('Zeil 51, 60313 Frankfurt')!.plz, '')
  assert.equal(hhProblem({ tatort: '' }), 'Der Tatort braucht mindestens die Straße (Adresse aus der Vorschlagsliste wählen).')
  assert.equal(hhProblem({ tatort: 'Hammer Straße 30, 22041 Hamburg' }, { email: '' }), 'Hamburg verlangt eine E-Mail-Adresse.')
  const u = { vorname: 'Max', nachname: 'M', strasse: 'Zeil', hausnummer: '51', plz: '60313', ort: 'Frankfurt am Main', email: 'm@x' } as any
  const p = buildHhPayload({ verstoss_art: '141322 – Sie parkten unzulässig im eingeschränkten Haltverbot (Zeichen 286).', kennzeichen: 'HH-OW 1234', fahrzeug_typ: 'Elektrokleinstfahrzeug', fahrzeug_marke: 'VW', fahrzeug_modell: 'Golf', tattag: '2026-10-08', tatzeit_von: '10:00:00', tatort: 'Hammer Straße 30, 22041 Hamburg', behinderung: 1, behinderung_text: 'Kinderwagen', fahrzeug_verlassen: 1 } as any, u, '2026-10-08 10:20')
  assert.equal(p.portal, 'intelliform-hh')
  assert.deepEqual(p.tatbestand, { radio: 'keine', liste: '12', behinderung: true, sachverhalt: 'Tatbestand laut Bußgeldkatalog: 141322 – Sie parkten unzulässig im eingeschränkten Haltverbot (Zeichen 286). Das Fahrzeug war verlassen. Behinderung: Kinderwagen' })
  assert.equal(p.fahrzeug.typ, 'Elektrokleinstfahrzeuge', 'Hamburger Typ-Liste schreibt den Plural')
  assert.equal(p.fahrzeug.marke, 'VW Golf')
  assert.deepEqual(p.tat, { datum: '08.10.2026', von: '10:00', bis: '10:20', strasse: 'Hammer Straße', hausnummer: '30', plz: '22041', angaben: '' })
  assert.equal(p.bestaetigungEmail, 'm@x')
  assert.deepEqual(hhFotos([1, 2, 3, 4]), { uebersicht: [2, 1, 3], fahrzeug: [] }, 'höchstens 3, Fahrzeugfoto zuerst')
  assert.equal(portalFuer('hamburg')!.id, 'intelliform-hh')
  assert.equal(getCity('hamburg').mail, undefined, 'Hamburg läuft übers Portal, nicht per Mail')
})
