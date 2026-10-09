// Hamburg: „Ordnungswidrigkeit im Straßenverkehr anzeigen" im Serviceportal
// (IntelliForm auf am.hamburg.de, Bußgeldstelle). Erkundet 2026-10-09, Details
// und Datenaufbereitung in src/services/portalHh.ts.
//
// Anders als civento (lib.mjs): klassische Seitenfolge mit vollem Reload je
// „Weiter" (#default-button), stabile Feld-IDs (id-input-<name>), Seitentitel
// in der Dialogverlauf-Leiste (li.present) bzw. als zweite Überschrift.
// Validierungsfehler stehen als Text „Fehler beim Ausfüllen: …" oben auf der
// Seite, Adressabgleich schlägt mit „Meinten Sie vielleicht: …" an.
// Straße am Tatort ist eine Kendo-Autocomplete (nur Listeneinträge gültig).
// Grundsatz wie in lib.mjs: Unklares führt zu run.pause(), nicht zum Abbruch.

import { Cancelled, sleep, portalSafe, norm, pdfText } from './lib.mjs'

const START = 'https://serviceportal.hamburg.de/HamburgGateway/Service/StartService/AFMAnzeige?ars=020000000000'

const SEITEN = [
  'Optionale Anmeldung', 'Hinweis zum Datenschutz', 'Rechtliche Hinweise zum Verfahren', 'Persönliche Angaben',
  'Tatzeit und Tatort', 'Fahrzeug und Tatbestand', 'Beweisfotos', 'Zusammenfassung',
]

/** Aktuelle Seite: Dialogverlauf (li.present) oder die letzte Überschrift unter
 *  dem Formulartitel (Anmeldung, Zusammenfassung, Abschluss haben keinen Verlauf). */
async function currentPage(page) {
  const title = await page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const li = document.querySelector('li.present')
    if (li) return (li.innerText || '').split('\n')[0].trim()
    const hs = [...document.querySelectorAll('h1, h2')].filter(vis).map((e) => e.innerText.trim()).filter(Boolean)
    return hs.find((h) => h !== 'Ordnungswidrigkeit im Straßenverkehr anzeigen') || hs[0] || ''
  }).catch(() => '')
  const n = SEITEN.indexOf(title)
  return { n: n < 0 ? 0 : n + 1, title }
}

/** Fehlertext der Seite: die Meldung „Fehler beim Ausfüllen: …" samt den
 *  Zeilen direkt dahinter (Adressvorschlag) und alle Feldhinweise der Seite
 *  („Bitte …", „Pflichtfeld", „ungültig"). */
async function fehlerText(page) {
  const text = await page.evaluate(() => (document.getElementById('if') || document.body).innerText || '')
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const i = lines.findIndex((l) => /^Fehler beim Ausfüllen/.test(l))
  if (i < 0) return ''
  const out = [lines[i]]
  for (const l of lines.slice(i + 1, i + 6)) {
    if (/^(Vornamen|Datum \(TT|Fahrzeugtyp|Beweisfoto hochladen|Angaben zum Fahrzeug)\b/.test(l)) break
    out.push(l)
  }
  for (const l of lines) {
    if (out.includes(l) || out.length > 10) continue
    if (/^(Bitte (geben|wählen|füllen|kontrollieren|überprüfen)|Pflichtfeld|Dieses Feld|Das Feld|Ungültig|Der Wert)/.test(l) && !/^Bitte geben Sie das Kennzeichen im Format/.test(l)) out.push(l)
  }
  return norm(out.join(' ')).slice(0, 500)
}

async function fill(page, name, value, { optional = false } = {}) {
  if (value == null || value === '') return
  const loc = page.locator(`[name="input.${name}"]`)
  if (!(await loc.count())) {
    if (optional) return
    throw new Error(`Feld „${name}" nicht gefunden.`)
  }
  const el = loc.first()
  if (await el.evaluate((e) => e.readOnly || e.disabled).catch(() => false)) return
  await el.fill(portalSafe(String(value)))
}

/** Radios, Listen und Häkchen lösen per onchange einen Server-Roundtrip aus
 *  (die URL bekommt einen neuen state-Parameter, Felder bleiben erhalten).
 *  Bis dahin nichts weiter eintippen, sonst geht die Eingabe verloren. */
async function roundtrip(page, action) {
  const before = page.url()
  await action()
  const until = Date.now() + 6000
  while (Date.now() < until && page.url() === before) await sleep(150)
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await sleep(500)
}

/** Häkchen über das Label (das Label-Markup liegt über dem Input). */
async function tick(page, id) {
  await roundtrip(page, () => tickNow(page, id))
}

async function tickNow(page, id) {
  const ok = await page.evaluate((id) => {
    const i = document.getElementById(id)
    if (!i) return null
    if (!i.checked) (document.querySelector(`label[for="${id}"]`) || i).click()
    if (!i.checked) i.click()
    return i.checked
  }, id)
  if (ok === null) throw new Error(`Häkchen „${id}" nicht gefunden.`)
  if (!ok) throw new Error(`Häkchen „${id}" ließ sich nicht setzen.`)
}

async function weiter(page) {
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
    page.click('#default-button'),
  ])
  await sleep(1200)
}

// ---------------------------------------------------------------------------
// Seiten

async function stepHinweise(run, page) {
  await tick(page, 'id-input-bestaetigung')
  run.log('Rechtliche Hinweise bestätigt (u. a. persönliche Betroffenheit)')
}

async function stepPerson(run, page, p) {
  const a = p.person
  await fill(page, 'vorname', a.vorname)
  await fill(page, 'nachname', a.nachname)
  await fill(page, 'strasse', a.strasse)
  await fill(page, 'hausnummer', a.hausnummer)
  await fill(page, 'plz', a.plz)
  await fill(page, 'ort', a.ort)
  await fill(page, 'email', a.email)
  run.log(`Anzeigende Person: ${a.vorname} ${a.nachname}, ${a.strasse} ${a.hausnummer}, ${a.plz} ${a.ort}`)
}

/** Straße aus der Vorschlagsliste wählen: tippen, Liste abwarten, passenden
 *  Eintrag klicken. Kein passender Eintrag → Nutzer wählt im Live-Bild. */
async function chooseStreet(run, page, strasse) {
  const input = page.locator('[name="input.strasse"]')
  await input.click()
  await input.fill('')
  const key = (s) => norm(s).toLowerCase().replace(/str\.(\s|$)/g, 'straße$1').replace(/\s+/g, ' ')
  const want = key(strasse)
  // Erst ein Präfix tippen (die Liste filtert serverseitig), dann vergleichen.
  await input.type(strasse.slice(0, Math.min(strasse.length, 10)), { delay: 40 })
  let items = []
  for (let i = 0; i < 12; i++) {
    await sleep(500)
    items = await page.locator('#id-input-strasse_listbox .k-list-item').allInnerTexts().catch(() => [])
    if (items.length) break
  }
  let hit = items.findIndex((t) => key(t) === want)
  if (hit < 0 && items.length) {
    // Längeres Tippen schränkt weiter ein (z. B. „Hammer Straße" vs. „Hammer Landstraße").
    await input.fill(strasse)
    await sleep(1200)
    items = await page.locator('#id-input-strasse_listbox .k-list-item').allInnerTexts().catch(() => [])
    hit = items.findIndex((t) => key(t) === want)
    if (hit < 0 && items.length === 1) hit = 0
  }
  if (hit >= 0) {
    try {
      await page.locator('#id-input-strasse_listbox .k-list-item').nth(hit).click({ timeout: 5000 })
    } catch {
      // Liste klappte beim Klick zu (Kendo rendert nach) – per Tastatur wählen.
      await input.focus()
      for (let i = 0; i <= hit; i++) await page.keyboard.press('ArrowDown')
      await page.keyboard.press('Enter')
    }
    await sleep(400)
    const now = await input.inputValue().catch(() => '')
    if (key(now) !== key(items[hit])) throw new Error(`Straße „${strasse}" ließ sich nicht aus der Liste übernehmen (Feld zeigt „${now}").`)
    run.log(`Straße gewählt: ${items[hit].trim()}`)
    return
  }
  await run.pause(`Die Straße „${strasse}" steht nicht in der Vorschlagsliste des Portals${items.length ? ` (Treffer: ${items.slice(0, 5).map((t) => t.trim()).join(', ')})` : ''}. Bitte im Live-Bild die Straße aus der Liste wählen und „Fortsetzen" klicken.`)
  run.log(`Straße manuell: ${await input.inputValue().catch(() => '?')}`)
}

async function stepTat(run, page, p) {
  const t = p.tat
  await fill(page, 'datum_temp', t.datum)
  await fill(page, 'tatzeit_von', t.von)
  await fill(page, 'tatzeit_bis', t.bis, { optional: true })
  await chooseStreet(run, page, t.strasse)
  await fill(page, 'hausnummer', t.hausnummer, { optional: true })
  await fill(page, 'plz', t.plz, { optional: true })
  // „Ort" ist schreibgeschützt mit „Hamburg" vorbelegt.
  await fill(page, 'tatortangaben', t.angaben, { optional: true })
  run.log(`Tat: ${t.datum} ${t.von}${t.bis ? `–${t.bis}` : ''}, ${t.strasse} ${t.hausnummer || ''}${t.plz ? `, ${t.plz}` : ''}`)
}

async function stepFahrzeug(run, page, p) {
  const f = p.fahrzeug
  try {
    await page.selectOption('[name="input.fahrzeug_typ"]', { label: f.typ })
  } catch {
    run.log(`Fahrzeugtyp „${f.typ}" nicht in der Liste – PKW gewählt`)
    await page.selectOption('[name="input.fahrzeug_typ"]', { label: 'PKW' })
  }
  await fill(page, 'kennzeichen_temp', f.kennzeichen)
  await fill(page, 'marke', f.marke, { optional: true })
  await fill(page, 'fahrzeugfarbe', f.farbe, { optional: true })
  const tb = p.tatbestand
  await tick(page, `id-input-tatbestand_1-${tb.radio}`)
  if (tb.radio === 'keine') {
    const sel = page.locator('select[name="input.tatbestand_2"]')
    await sel.waitFor({ state: 'visible', timeout: 10000 })
    // Optionswerte sind „<Nr>|<Text>" – über die Nummer wählen.
    const value = await sel.evaluate((s, nr) => [...s.options].map((o) => o.value).find((v) => v.startsWith(`${nr}|`)) || null, tb.liste)
    if (!value) throw new Error(`Tatvorwurf Nr. ${tb.liste} steht nicht (mehr) in der Liste.`)
    await roundtrip(page, () => sel.selectOption(value))
    run.log(`Tatvorwurf: ${value.split('|')[1] || value}`)
  } else {
    run.log(`Tatvorwurf: Nr. ${tb.radio}`)
  }
  if (tb.behinderung) await tick(page, 'id-input-behinderung')
  // Mit Behinderung heißt das Feld „sachverhalt_pflicht" und ist Pflicht.
  if (await page.locator('[name="input.sachverhalt_pflicht"]').count()) await fill(page, 'sachverhalt_pflicht', tb.sachverhalt || 'Siehe Beweisfotos.')
  else await fill(page, 'sachverhalt', tb.sachverhalt, { optional: true })
  run.log(`Fahrzeug: ${f.typ} ${f.kennzeichen}${f.marke ? `, ${f.marke}` : ''}${f.farbe ? `, ${f.farbe}` : ''}${tb.behinderung ? ' – mit Behinderung' : ''}`)
}

async function stepFotos(run, page) {
  // Höchstens 3 (Formular), Rolle egal – die App gibt schon die richtige Auswahl mit.
  const files = [...run.files.uebersicht, ...run.files.fahrzeug].slice(0, 3)
  if (!files.length) throw new Error('Keine Beweisfotos vorhanden.')
  const hochgeladen = async () => page.locator('button[name^="submit.stay.file.del.beweisfoto"]').count()
  const vorher = await hochgeladen()
  if (vorher < files.length) {
    await page.locator('#id-input-beweisfoto').setInputFiles(files.slice(vorher))
    run.log(`${files.length - vorher} Beweisfoto(s) werden hochgeladen …`)
    const until = Date.now() + 120000
    while ((await hochgeladen()) < files.length) {
      if (Date.now() > until) throw new Error('Foto-Upload nicht abgeschlossen.')
      await sleep(800)
    }
  }
  run.log(`${await hochgeladen()} Beweisfoto(s) hochgeladen`)
  await tick(page, 'id-input-fotos_bestaetigung')
}

const HANDLER = {
  'Optionale Anmeldung': null, // #default-button = „Ohne Anmeldung fortsetzen"
  'Hinweis zum Datenschutz': null,
  'Rechtliche Hinweise zum Verfahren': stepHinweise,
  'Persönliche Angaben': stepPerson,
  'Tatzeit und Tatort': stepTat,
  'Fahrzeug und Tatbestand': stepFahrzeug,
  Beweisfotos: stepFotos,
}

// ---------------------------------------------------------------------------
// Ablauf

async function fillHamburg(run) {
  const { page, payload } = run
  run.log('Serviceportal Hamburg wird geöffnet …')
  await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(1500)
  const handled = new Set()
  const manual = new Set()
  for (let guard = 0; guard < 40; guard++) {
    run.check()
    const pg = await currentPage(page)
    run.setStep(pg)
    if (pg.title === 'Zusammenfassung') return
    if (!pg.title) {
      await run.pause('Die Seite des Portals wurde nicht erkannt. Bitte im Live-Bild prüfen und „Fortsetzen" klicken.')
      continue
    }
    if (!handled.has(pg.title) && !manual.has(pg.title)) {
      run.log(`Seite: ${pg.title}`)
      try {
        const fn = HANDLER[pg.title]
        if (fn === undefined) throw new Error(`Unbekannte Seite „${pg.title}".`)
        if (fn) await fn(run, page, payload)
        handled.add(pg.title)
      } catch (err) {
        if (err instanceof Cancelled) throw err
        run.log(`Problem: ${err.message}`)
        await run.pause(`${err.message} Bitte diese Seite im Live-Bild vervollständigen und „Fortsetzen" klicken.`)
        manual.add(pg.title)
        continue
      }
    }
    // Hat der Nutzer im Live-Bild schon weitergeklickt?
    if ((await currentPage(page)).title !== pg.title) continue
    await weiter(page)
    if ((await currentPage(page)).title === pg.title) {
      const fehler = await fehlerText(page)
      run.log(`Portal meldet: ${fehler || 'Seite wechselt nicht'}`)
      await run.pause(`Das Portal meldet: ${fehler || 'Seite wechselt nicht'}. Bitte im Live-Bild korrigieren und „Fortsetzen" klicken.`)
      manual.add(pg.title)
    }
  }
  throw new Error('Zu viele Seiten – Formularablauf unerwartet.')
}

/** Amts-PDF bzw. Anlagen der Zusammenfassung über die Sitzung laden. */
async function fetchAttachment(page, selector) {
  const href = await page.locator(selector).first().getAttribute('href').catch(() => null)
  if (!href) return null
  const res = await page.request.get(new URL(href, page.url()).toString(), { timeout: 60000 })
  if (!res.ok()) return null
  const buffer = await res.body()
  return buffer.length ? buffer : null
}

/** Auf der Zusammenfassung: Sendebestätigung eintragen, Amts-PDF sichern,
 *  „Weiter" (= einreichen) und die Abschlussseite auswerten. */
async function submitHamburg(run) {
  const { page, payload } = run
  if (payload.bestaetigungEmail) {
    await page.locator('#email').fill(payload.bestaetigungEmail).catch(() => run.log('Feld für die Sendebestätigung nicht gefunden'))
  }
  let receipt = null
  // Das Amts-PDF der Zusammenfassung trägt schon die „OD-Vorgangsnummer"
  // (20-stellig, z. B. 20261009153550511516) – mit Wasserzeichen „noch nicht
  // gesendet". Falls die Abschlussseite keine Nummer nennt, gilt diese.
  let pdfVorgang = null
  const pdf = await fetchAttachment(page, 'a[href*="id=myForm-pdf"]').catch(() => null)
  if (pdf) {
    receipt = { buffer: pdf, name: 'Anzeige_einer_Ordnungswidrigkeit_im_Strassenverkehr.pdf' }
    pdfVorgang = (await pdfText(pdf).catch(() => '')).match(/OD-Vorgangsnummer:\s*(\d{8,})/)?.[1] || null
    run.log(`Amts-PDF der Zusammenfassung gesichert (${Math.round(pdf.length / 1024)} KB)${pdfVorgang ? `, OD-Vorgangsnummer ${pdfVorgang}` : ''}`)
  } else {
    run.log('Amts-PDF der Zusammenfassung nicht gefunden')
  }
  await weiter(page)
  run.log('Einreichen geklickt – warte auf Bestätigung …')
  const until = Date.now() + 120000
  let text = ''
  for (;;) {
    await sleep(800)
    text = await page.evaluate(() => document.body.innerText || '').catch(() => '')
    const pg = await currentPage(page)
    if (pg.title && pg.title !== 'Zusammenfassung' && !/Fehler beim Ausfüllen/.test(text)) break
    if (/Fehler beim Ausfüllen/.test(text)) throw new Error(`Das Portal meldet beim Einreichen: ${await fehlerText(page)}`)
    if (Date.now() > until) throw new Error('Keine Bestätigungsseite nach dem Einreichen.')
  }
  await sleep(1500)
  text = await page.evaluate(() => (document.querySelector('main') || document.body).innerText || '')
  const m =
    text.match(/(?:OD-)?(?:Vorgangs|Eingangs|Antrags|Transaktions|Referenz)-?\s?(?:ID|nummer|kennung|kennzeichen|nr\.?)\s*(?:lautet)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-_./]{3,})/i) ||
    text.match(/\b(\d{4,}[-/][A-Za-z0-9-/]{3,})\b/)
  const vorgangsId = (m ? m[1].replace(/[.,;]$/, '') : null) || pdfVorgang
  run.log(vorgangsId ? `Vorgangs-ID: ${vorgangsId}${m ? '' : ' (aus dem Amts-PDF)'}` : 'Keine Vorgangs-ID auf der Abschlussseite erkannt.')
  // Bietet die Abschlussseite ein eigenes PDF (Eingangsbestätigung), ist das der bessere Beleg.
  const final = await fetchAttachment(page, 'a[href*="attachment-show"][href*="pdf" i], a[href$=".pdf"]').catch(() => null)
  if (final) {
    receipt = { buffer: final, name: 'Eingangsbestaetigung.pdf' }
    run.log(`Beleg der Abschlussseite gesichert (${Math.round(final.length / 1024)} KB)`)
  }
  return { text, vorgangsId, receipt }
}

export const PROFILE = {
  'intelliform-hh': {
    startUrl: START,
    isSummary: (step) => step.title === 'Zusammenfassung',
    fill: fillHamburg,
    submit: submitHamburg,
  },
}
