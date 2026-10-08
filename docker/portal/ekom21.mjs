// Ausfüllen des ekom21/civento-Formulars „Anzeige einer Verkehrsordnungswidrigkeit"
// (Ordnungsamt Frankfurt). Die Seite ist eine GWT-Anwendung: jeder Schritt ist
// ein großer RPC-Aufruf mit Integritäts-Token, daher kein HTTP-Nachbau, sondern
// echtes Durchklicken.
//
// Aufbau: Schleife über die Formularschritte. Der aktuelle Schritt wird an
// seiner Überschrift („Schritt N <Titel>") erkannt, der passende Handler füllt
// ihn aus, danach „Weiter". Alles, was nicht eindeutig klappt (mehrdeutiger
// Tatbestand, unbekannte Option, Validierungsfehler des Portals), führt NICHT
// zum Abbruch, sondern zu run.pause(): der Nutzer korrigiert im Live-Bild und
// klickt „Fortsetzen". Abgeschickt wird erst nach run.waitSubmit().
//
// Eigenheiten des Portals:
// - Auswahllisten sind select2 (Klick auf [role=combobox] → .select2-results__option).
// - Radio-Labels enthalten große Bilder (Verkehrszeichen); Playwright-Klicks auf
//   das versteckte Input scheitern, daher JS-Klick auf das Input.
// - Während eines RPC liegt ein „Bitte warten"-Overlay über der Seite.

export const START_URL =
  'https://portal-civ.ekom21.de/civ.public/start.html?oe=00.00.PA.FFOrdA&mode=cc&cc_key=AnzeigeOwi'

export class Cancelled extends Error {}

const norm = (s) => String(s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Das Portal lehnt in Textfeldern Zeichen außerhalb von Latin-1 ab („Das Feld
 *  enthält ungültige Zeichen", z.B. beim Gedankenstrich –). Typografische
 *  Zeichen daher ersetzen, den Rest entfernen. */
export function portalSafe(s) {
  return String(s ?? '')
    .normalize('NFC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u201C-\u201F\u00AB\u00BB]/g, '"')
    .replace(/[\u2018-\u201B]/g, "'")
    .replace(/\u2026/g, '...')
    .replace(/\u20AC/g, 'EUR')
    .replace(/[\u00A0\u2000-\u200B\u202F]/g, ' ')
    .replace(/[^\n\u0020-\u007E\u00A1-\u00FF]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

// ---------------------------------------------------------------------------
// Seitenzustand

async function pageText(page) {
  return page.evaluate(() => document.body.innerText || '')
}

async function isBusy(page) {
  return (await pageText(page)).includes('Bitte warten')
}

/** Aktueller Schritt aus der Schrittleiste: die Zeile „Schritt N Titel" ohne
 *  den Zusatz „wurde bereits bearbeitet." */
export async function currentStep(page) {
  const text = await page.evaluate(() => (document.querySelector('main') || document.body).innerText || '')
  let cur = null
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^Schritt (\d+) (.+)$/)
    if (m && !/wurde bereits bearbeitet\.?$/.test(m[2])) cur = { n: Number(m[1]), title: m[2].trim() }
  }
  return cur || { n: 0, title: '' }
}

const stepKey = (s) => `${s.n}:${s.title}`

async function waitReady(page, timeout = 90000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (!(await isBusy(page)) && (await currentStep(page)).n > 0) return
    await sleep(400)
  }
  throw new Error('Das Portal hat nicht rechtzeitig geladen.')
}

/** Sichtbare Fehlermeldungen des Portals (Pflichtfelder usw.) mit Feldname. */
async function validationErrors(page) {
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const out = []
    for (const e of document.querySelectorAll('.field-error-label, .sjf-error-placeholder, .error, [role=alert]')) {
      const t = (e.innerText || '').trim()
      // Upload-Bestätigungen stehen im selben Platzhalter wie Fehler.
      if (!t || !vis(e) || /^Erfolg\b/.test(t)) continue
      const box = e.closest('.input-field, .row, fieldset')
      const label = box?.querySelector('label, legend')?.innerText?.replace(/\*/g, '').trim()
      out.push(label && !t.includes(label) ? `${label}: ${t}` : t)
    }
    return [...new Set(out)].join(' · ')
  })
}

async function clickButton(page, name) {
  const btn = page.getByRole('button', { name, exact: true })
  await btn.scrollIntoViewIfNeeded().catch(() => {})
  await btn.click({ timeout: 15000 })
}

/** Nach „Weiter": warten, bis ein anderer Schritt da ist. false, wenn die Seite
 *  stehen bleibt (meist Validierungsfehler). */
async function waitStepChange(page, beforeKey, timeout = 60000) {
  const start = Date.now()
  await sleep(600)
  while (Date.now() - start < timeout) {
    if (!(await isBusy(page))) {
      const s = await currentStep(page)
      if (stepKey(s) !== beforeKey) return true
      if (Date.now() - start > 4000) return false
    }
    await sleep(400)
  }
  return false
}

// ---------------------------------------------------------------------------
// Felder

/** ID des sichtbaren Eingabefelds zu einem Label (ohne Sternchen; exakt oder Präfix). */
async function fieldId(page, label, prefix = false) {
  return page.evaluate(([label, prefix]) => {
    const norm = (s) => String(s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim()
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    for (const l of document.querySelectorAll('label[for]')) {
      const t = norm(l.innerText)
      if (prefix ? t.startsWith(label) : t === label) {
        const el = document.getElementById(l.htmlFor)
        if (el && vis(el) && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return l.htmlFor
      }
    }
    return null
  }, [label, prefix])
}

async function fillText(page, label, value, { prefix = false, optional = false } = {}) {
  if (value == null || value === '') return
  const id = await fieldId(page, label, prefix)
  if (!id) {
    if (optional) return
    throw new Error(`Feld „${label}" nicht gefunden.`)
  }
  const loc = page.locator(`[id="${id}"]`)
  const max = Number(await loc.getAttribute('maxlength'))
  const safe = portalSafe(value)
  const text = max > 0 ? safe.slice(0, max) : safe
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  await loc.fill(text)
  await loc.press('Tab')
}

/** select2-Auswahl über die sichtbare Oberfläche (GWT hört auf deren Events). */
async function select2(page, label, option) {
  if (!option) return
  const box = page.locator('.combobox').filter({ has: page.locator('label', { hasText: label }) }).first()
  const combo = box.locator('[role=combobox]')
  await combo.scrollIntoViewIfNeeded().catch(() => {})
  await combo.click()
  const search = page.locator('.select2-container--open .select2-search__field')
  if ((await search.count()) && (await search.first().isVisible())) await search.first().fill(option)
  const opt = page
    .locator('.select2-results__option')
    .filter({ hasText: new RegExp(`^\\s*${escapeRe(option)}\\s*$`) })
    .first()
  try {
    await opt.click({ timeout: 5000 })
  } catch {
    await page.keyboard.press('Escape').catch(() => {})
    throw new Error(`Auswahl „${option}" bei „${label}" nicht gefunden.`)
  }
  await sleep(400)
}

/** Sichtbare Radio-Buttons in DOM-Reihenfolge (Gruppe = name-Attribut). */
async function visibleRadios(page) {
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const out = []
    for (const i of document.querySelectorAll('input[type=radio]')) {
      const l = document.querySelector(`label[for="${i.id}"]`)
      if (!l || !vis(l)) continue
      out.push({ id: i.id, name: i.name, text: l.innerText.replace(/\s+/g, ' ').trim(), checked: i.checked })
    }
    return out
  })
}

async function clickRadioId(page, id) {
  const ok = await page.evaluate((id) => {
    const i = document.getElementById(id)
    if (!i) return false
    i.scrollIntoView({ block: 'center' })
    if (!i.checked) i.click()
    return i.checked
  }, id)
  if (!ok) throw new Error('Auswahl ließ sich nicht setzen.')
  await sleep(900)
}

const matches = (text, cand) => {
  const t = norm(text).toLowerCase()
  const c = norm(cand).toLowerCase()
  return t === c || t.startsWith(c)
}

// ---------------------------------------------------------------------------
// Tatbestand-Pfad
//
// Ein Pfad ist eine Liste von Elementen, jeweils eine Radio-Gruppe:
//   { pick: [a, b] }   erste vorhandene Option in dieser Reihenfolge wählen
//   { ask: [a, b] }    genau eine vorhanden → wählen, sonst Nutzer fragen
//   { manual: true }   Nutzer wählt selbst
//   optional: true     fehlt die Option (Portal fragt das hier nicht), überspringen
// Optionen werden per Präfix verglichen.

const isYesNo = (group) => group.length === 2 && group.some((o) => o.text === 'Ja') && group.some((o) => o.text === 'Nein')

function groupsOf(radios, used) {
  const groups = new Map()
  for (const r of radios) {
    if (used.has(r.name)) continue
    if (!groups.has(r.name)) groups.set(r.name, [])
    groups.get(r.name).push(r)
  }
  return [...groups.entries()].filter(([, opts]) => !isYesNo(opts))
}

/** Nach einer manuellen Auswahl: die gewählte, bisher unbenutzte Gruppe merken. */
async function adoptManualChoice(page, used) {
  for (const [name, opts] of groupsOf(await visibleRadios(page), used)) {
    if (opts.some((o) => o.checked)) {
      used.add(name)
      return opts.find((o) => o.checked).text
    }
  }
  return null
}

async function choosePathElement(run, page, el, used) {
  const cands = el.pick || el.ask || []
  const until = Date.now() + (el.optional ? 3000 : 8000)
  let found = []
  while (Date.now() < until) {
    for (const [name, opts] of groupsOf(await visibleRadios(page), used)) {
      for (const c of cands) {
        const o = opts.find((o) => matches(o.text, c))
        if (o) found.push({ name, o, c })
      }
      if (found.length) break
    }
    if (found.length) break
    await sleep(500)
  }

  if (el.pick && found.length) {
    const best = cands.map((c) => found.find((f) => f.c === c)).find(Boolean)
    await clickRadioId(page, best.o.id)
    used.add(best.name)
    run.log(`Gewählt: ${best.o.text}`)
    return
  }
  if (el.ask && found.length === 1) {
    await clickRadioId(page, found[0].o.id)
    used.add(found[0].name)
    run.log(`Gewählt: ${found[0].o.text}`)
    return
  }
  if (!found.length && el.optional) return

  // Die betroffene Auswahl ins Live-Bild holen, damit der Nutzer nicht suchen muss.
  const focusId = found[0]?.o.id || groupsOf(await visibleRadios(page), used)[0]?.[1][0]?.id
  if (focusId) {
    await page.evaluate((id) => document.querySelector(`label[for="${id}"]`)?.scrollIntoView({ block: 'center' }), focusId).catch(() => {})
  }
  const msg = el.manual
    ? el.hint || 'Bitte die passende Option im Live-Bild auswählen.'
    : el.ask && found.length > 1
      ? `Bitte im Live-Bild wählen: ${found.map((f) => f.o.text).join(' oder ')}${el.hint ? ` (${el.hint})` : ''}`
      : `Option „${cands.join('" / „')}" gibt es hier nicht – bitte die passende Option im Live-Bild auswählen.`
  for (;;) {
    await run.pause(msg)
    const chosen = await adoptManualChoice(page, used)
    if (chosen) {
      run.log(`Manuell gewählt: ${chosen}`)
      return
    }
  }
}

/** Ja/Nein-Fragen zur Behinderung beantworten (inkl. Pflichttext bei Ja). */
async function answerBehinderung(run, page, p) {
  const done = new Set()
  for (let round = 0; round < 4; round++) {
    await sleep(700)
    const radios = await visibleRadios(page)
    const groups = new Map()
    for (const r of radios) {
      if (!groups.has(r.name)) groups.set(r.name, [])
      groups.get(r.name).push(r)
    }
    const open = [...groups.entries()].filter(([name, opts]) => isYesNo(opts) && !done.has(name))
    if (!open.length) break
    for (const [name, opts] of open) {
      const rettung = /Rettungsfahrzeug/i.test(name)
      const ja = rettung ? !!p.behinderung.rettung : !!p.behinderung.ja
      await clickRadioId(page, opts.find((o) => o.text === (ja ? 'Ja' : 'Nein')).id)
      done.add(name)
      run.log(`${name.replace(/[\d.]+$/, '')} ${ja ? 'Ja' : 'Nein'}`)
    }
  }
  if (p.behinderung.ja || p.behinderung.rettung) {
    await sleep(500)
    await fillText(page, 'Bitte beschreiben Sie die Behinderung', p.behinderung.text || 'Siehe Beweisfotos.', { prefix: true, optional: true })
  }
}

// ---------------------------------------------------------------------------
// Uploads

/** Anzahl hochgeladener Dateien je Upload-Bereich (in Seitenreihenfolge). */
async function uploadedCounts(page) {
  const t = await pageText(page)
  return [...t.matchAll(/hochgeladen:\s*(\d+|keine)/gi)].map((m) => (m[1] === 'keine' ? 0 : Number(m[1])))
}

async function uploadSection(run, page, index, sectionLabel, files) {
  if (!files.length) return
  const have = (await uploadedCounts(page))[index] || 0
  if (have >= files.length) return
  const btn = page.getByRole('button', { name: new RegExp(`${escapeRe(sectionLabel)}.*Hochladen`) })
  await btn.scrollIntoViewIfNeeded().catch(() => {})
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15000 }), btn.click()])
  await chooser.setFiles(chooser.isMultiple() ? files : files.slice(0, 1))
  run.log(`${sectionLabel}: ${files.length} Datei(en) werden hochgeladen …`)
  const until = Date.now() + 120000
  while (Date.now() < until) {
    await sleep(800)
    const n = (await uploadedCounts(page))[index] || 0
    if (n >= files.length && !(await isBusy(page))) {
      run.log(`${sectionLabel}: ${n} hochgeladen`)
      return
    }
    if (!chooser.isMultiple() && n >= 1 && files.length > 1) {
      // Einzel-Upload: restliche Dateien nacheinander
      return uploadSection(run, page, index, sectionLabel, files)
    }
  }
  throw new Error(`${sectionLabel}: Upload nicht abgeschlossen.`)
}

// ---------------------------------------------------------------------------
// Schritte

async function stepAntragsteller(run, page, p) {
  const radios = await visibleRadios(page)
  const manual = radios.find((r) => r.text.startsWith('Daten manuell eingeben'))
  if (manual) {
    await clickRadioId(page, manual.id)
    run.log('Authentifizierung: Daten manuell eingeben')
    return
  }
  const a = p.person
  await select2(page, 'Anrede', a.anrede)
  await fillText(page, 'Name', a.name)
  await fillText(page, 'Vorname', a.vorname)
  await fillText(page, 'Postleitzahl', a.plz)
  await fillText(page, 'Ort', a.ort)
  await fillText(page, 'Straße/Postfach', a.strasse)
  await fillText(page, 'Nr.', a.nr)
  await fillText(page, 'Telefonnummer', a.telefon, { optional: true })
  run.log(`Anzeigende Person: ${a.vorname} ${a.name}, ${a.strasse} ${a.nr}, ${a.plz} ${a.ort}`)
}

async function stepAngaben(run, page, p, used) {
  await choosePathElement(run, page, p.gruppe ? { pick: [p.gruppe] } : { manual: true, hint: 'Bitte die Rubrik der Ordnungswidrigkeit im Live-Bild auswählen.' }, used)
  const f = p.fahrzeug
  await select2(page, 'Fahrzeugtyp', f.typ || 'PKW')
  // Auch „Deutschland" ausdrücklich wählen – vorausgewählt ist es nur optisch,
  // ohne Auswahl steht in der Zusammenfassung „Kennzeichen-Land: -".
  await select2(page, 'Kennzeichen Land', f.land || 'Deutschland')
  await fillText(page, 'Kennzeichen', f.kennzeichen)
  if (f.marke) {
    try {
      await select2(page, 'Marke des Fahrzeuges', f.marke)
    } catch {
      await select2(page, 'Marke des Fahrzeuges', 'Sonstiges').catch(() => {})
      f.modell = [f.marke, f.modell].filter(Boolean).join(' ')
    }
  }
  await fillText(page, 'Fahrzeugmodell', f.modell, { optional: true })
  await fillText(page, 'Farbe', f.farbe, { optional: true })
  run.log(`Fahrzeug: ${f.typ || 'PKW'} ${f.kennzeichen}${f.marke ? `, ${f.marke}` : ''}${f.farbe ? `, ${f.farbe}` : ''}`)
}

async function stepDetails(run, page, p, used) {
  const pfad = p.pfad?.length ? p.pfad : [{ manual: true, hint: 'Bitte den Tatbestand im Live-Bild vollständig auswählen.' }]
  for (const el of pfad) await choosePathElement(run, page, el, used)
  await answerBehinderung(run, page, p)
}

async function stepTat(run, page, p) {
  const t = p.tat
  await fillText(page, 'Straße und Hausnummer', t.ort, { prefix: true })
  const dateId = await fieldId(page, 'Tattag (Datum)')
  if (!dateId) throw new Error('Feld „Tattag" nicht gefunden.')
  const date = page.locator(`[id="${dateId}"]`)
  await date.click()
  await date.fill(t.tattag)
  await date.press('Tab')
  await page.keyboard.press('Escape').catch(() => {})
  await fillText(page, 'Beginn Tatzeit', t.von)
  await fillText(page, 'Ende Tatzeit', t.bis)
  run.log(`Tat: ${t.ort}, ${t.tattag} ${t.von}–${t.bis}`)
  await uploadSection(run, page, 0, 'Beweis-Übersichtsfoto', run.files.uebersicht)
  await uploadSection(run, page, 1, 'Beweis-Fahrzeugfoto', run.files.fahrzeug)
}

async function stepVersicherung(run, page, p) {
  await fillText(page, 'Ihre E-Mail Adresse', p.email, { prefix: true, optional: true })
  const r = (await visibleRadios(page)).find((x) => x.text.startsWith('Ich versichere'))
  if (!r) throw new Error('Versicherung der Richtigkeit nicht gefunden.')
  await clickRadioId(page, r.id)
  run.log('Richtigkeit versichert')
}

// ---------------------------------------------------------------------------
// Ablauf

/** Füllt alles bis zur Zusammenfassung aus. */
export async function fillForm(run) {
  const { page, payload: p } = run
  run.log('Portal wird geöffnet …')
  await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await waitReady(page)

  const handled = new Set() // automatisch erledigte Schritte
  const manual = new Set() // Schritte, die der Nutzer selbst ausgefüllt hat
  const used = new Set() // beantwortete Radio-Gruppen

  for (let guard = 0; guard < 40; guard++) {
    run.check()
    const step = await currentStep(page)
    const key = stepKey(step)
    run.setStep(step)
    if (/überprüfen Sie Ihre Angaben/.test(step.title)) return

    if (!handled.has(key) && !manual.has(key)) {
      run.log(`Schritt ${step.n}: ${step.title}`)
      try {
        if (step.title === 'Start') { /* nur Hinweise */ }
        else if (step.title === 'Antragstellende Person') await stepAntragsteller(run, page, p)
        else if (step.title === 'Angaben der Ordnungswidrigkeiten') await stepAngaben(run, page, p, used)
        else if (step.title === 'Ordnungswidrigkeiten Details') await stepDetails(run, page, p, used)
        else if (step.title === 'Angaben zur Tat') await stepTat(run, page, p)
        else if (step.title === 'Versicherung der Richtigkeit der Angaben') await stepVersicherung(run, page, p)
        else throw new Error(`Unbekannter Schritt „${step.title}".`)
        handled.add(key)
      } catch (err) {
        if (err instanceof Cancelled) throw err
        run.log(`Problem: ${err.message}`)
        await run.pause(`${err.message} Bitte diesen Schritt im Live-Bild vervollständigen und „Fortsetzen" klicken.`)
        manual.add(key)
        continue
      }
    }

    // Hat der Nutzer im Live-Bild schon selbst weitergeklickt?
    if (stepKey(await currentStep(page)) !== key) continue
    await clickButton(page, 'Weiter')
    if (!(await waitStepChange(page, key))) {
      const errors = await validationErrors(page)
      await page.evaluate(() => {
        const e = [...document.querySelectorAll('.field-error-label, .sjf-error-placeholder')].find((x) => /Fehler/.test(x.innerText || ''))
        e?.scrollIntoView({ block: 'center' })
      }).catch(() => {})
      run.log(`Portal meldet: ${errors || 'Seite wechselt nicht'}`)
      await run.pause(`Das Portal meldet: ${errors || 'Seite wechselt nicht'}. Bitte im Live-Bild korrigieren und „Fortsetzen" klicken.`)
      manual.add(key)
    }
  }
  throw new Error('Zu viele Schritte – Formularablauf unerwartet.')
}

/** Zusammenfassung lesen (für die Akte). */
export async function readSummary(page) {
  return page.evaluate(() => (document.querySelector('main') || document.body).innerText || '')
}

/** „Absenden" klicken und die Abschlussseite auswerten. */
export async function submitForm(run) {
  const { page } = run
  const before = stepKey(await currentStep(page))
  await clickButton(page, 'Absenden')
  run.log('Absenden geklickt – warte auf Bestätigung …')
  const until = Date.now() + 120000
  for (;;) {
    await sleep(800)
    if (!(await isBusy(page))) {
      const text = await pageText(page)
      const step = await currentStep(page)
      if (stepKey(step) !== before && !text.includes('Bitte prüfen Sie Ihre Angaben')) break
    }
    if (Date.now() > until) throw new Error('Keine Bestätigungsseite nach dem Absenden.')
  }
  await sleep(1500)
  const text = await readSummary(page)
  const m =
    text.match(/Vorgangs-?\s?(?:ID|nummer|kennung|kennzeichen)\s*(?:lautet)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-_./]{3,})/i) ||
    text.match(/\b(\d{2,}[-/][A-Za-z0-9-/]{4,})\b/)
  const result = { text, vorgangsId: m ? m[1].replace(/[.,;]$/, '') : null, receipt: null }
  run.log(result.vorgangsId ? `Vorgangs-ID: ${result.vorgangsId}` : 'Keine Vorgangs-ID auf der Abschlussseite erkannt.')
  result.receipt = await downloadReceipt(run).catch((err) => {
    run.log(`Zusammenfassung nicht heruntergeladen: ${err.message}`)
    return null
  })
  if (!result.vorgangsId && result.receipt) {
    result.vorgangsId = await vorgangsIdAusPdf(result.receipt.buffer)
    run.log(result.vorgangsId ? `Vorgangs-ID (aus der Zusammenfassung): ${result.vorgangsId}` : 'Vorgangs-ID auch in der Zusammenfassung nicht gefunden.')
  }
  return result
}

/** Vorgangs-ID aus der PDF-Zusammenfassung: Fußzeile
 *  „Vorgang: Anzeige einer Ordnungswidrigkeit / 26.111745" (Stand 10/2026). */
export async function vorgangsIdAusPdf(buffer) {
  const { spawn } = await import('node:child_process')
  const text = await new Promise((resolve) => {
    const p = spawn('pdftotext', ['-layout', '-', '-'])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', () => resolve(''))
    p.on('close', () => resolve(out))
    p.stdin.on('error', () => {})
    p.stdin.end(buffer)
  })
  const m = text.match(/Vorgang:[^\n/]*\/\s*(\d{2}\.\d{3,})/) || text.match(/Vorgangs-?(?:ID|nummer)\s*:?\s*([A-Za-z0-9][A-Za-z0-9.\-/]{3,})/i)
  return m ? m[1] : null
}

/** PDF-Zusammenfassung der Abschlussseite holen (Download oder neues Fenster). */
async function downloadReceipt(run) {
  const { page, ctx } = run
  const candidates = page.locator('button, a').filter({ hasText: /herunterladen|download|zusammenfassung|pdf/i })
  const n = await candidates.count()
  for (let i = 0; i < n; i++) {
    const c = candidates.nth(i)
    if (!(await c.isVisible())) continue
    const dl = page.waitForEvent('download', { timeout: 30000 }).then(async (d) => {
      const path = await d.path()
      const fs = await import('node:fs/promises')
      return { buffer: await fs.readFile(path), name: d.suggestedFilename() }
    })
    const popup = ctx.waitForEvent('page', { timeout: 30000 }).then(async (pg) => {
      await pg.waitForLoadState('domcontentloaded').catch(() => {})
      const res = await pg.request.get(pg.url())
      const buffer = await res.body()
      await pg.close().catch(() => {})
      return { buffer, name: 'zusammenfassung.pdf' }
    })
    await c.click()
    const got = await Promise.any([dl, popup]).catch(() => null)
    if (got?.buffer?.length) {
      run.log(`Zusammenfassung heruntergeladen (${Math.round(got.buffer.length / 1024)} KB)`)
      return got
    }
  }
  return null
}
