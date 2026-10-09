// Gemeinsame Bausteine für civento-Formulare (GWT, Anbieter ekom21 in Hessen,
// antrag-kommunal.service.rlp.de in Rheinland-Pfalz). Jeder Schritt ist ein
// großer RPC-Aufruf mit Integritäts-Token, daher kein HTTP-Nachbau, sondern
// echtes Durchklicken. Die Städte-Profile (ekom21.mjs, mainz.mjs) liefern
// Start-URL und Handler je Schrittüberschrift; fillSteps() fährt die Schritte ab.
//
// Grundsatz: Was nicht eindeutig klappt (mehrdeutiger Tatbestand, unbekannte
// Option, Validierungsfehler), führt NICHT zum Abbruch, sondern zu run.pause():
// der Nutzer korrigiert im Live-Bild und klickt „Fortsetzen".
//
// Eigenheiten von civento:
// - Auswahllisten sind select2 (Klick auf [role=combobox] → .select2-results__option).
// - Radio-Labels enthalten oft große Bilder (Verkehrszeichen); Playwright-Klicks
//   auf das versteckte Input scheitern, daher JS-Klick auf das Input.
// - Während eines RPC liegt ein „Bitte warten"-Overlay über der Seite.
// - gwt-uid-IDs ändern sich bei jedem Neuaufbau: Felder immer übers Label finden.

export class Cancelled extends Error {}

export const norm = (s) => String(s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim()
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

export async function pageText(page) {
  return page.evaluate(() => document.body.innerText || '')
}

export async function isBusy(page) {
  return (await pageText(page)).includes('Bitte warten')
}

/** Aktueller Schritt aus der Schrittleiste: die Zeile „Schritt N Titel" ohne
 *  den Zusatz „wurde bereits bearbeitet." (ekom21) bzw. „abgeschlossen" (RLP). */
export async function currentStep(page) {
  const text = await page.evaluate(() => (document.querySelector('main') || document.body).innerText || '')
  let cur = null
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^Schritt (\d+) (.+)$/)
    if (m && !/(wurde bereits bearbeitet\.?|abgeschlossen)$/.test(m[2])) cur = { n: Number(m[1]), title: m[2].trim() }
  }
  return cur || { n: 0, title: '' }
}

export const stepKey = (s) => `${s.n}:${s.title}`

export async function waitReady(page, timeout = 90000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (!(await isBusy(page)) && (await currentStep(page)).n > 0) return
    await sleep(400)
  }
  throw new Error('Das Portal hat nicht rechtzeitig geladen.')
}

/** Sichtbare Fehlermeldungen des Portals (Pflichtfelder usw.) mit Feldname. */
export async function validationErrors(page) {
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    const out = []
    for (const e of document.querySelectorAll('.field-error-label, .sjf-error-placeholder, .error, [role=alert]')) {
      const t = (e.innerText || '').trim()
      // Upload-Bestätigungen stehen im selben Platzhalter wie Fehler.
      if (!t || !vis(e) || /^Erfolg\b/.test(t) || /^Wie zum Beispiel/.test(t)) continue
      const box = e.closest('.input-field, .row, fieldset')
      const label = box?.querySelector('label, legend')?.innerText?.replace(/\*/g, '').trim()
      out.push(label && !t.includes(label) ? `${label}: ${t}` : t)
    }
    return [...new Set(out)].join(' · ')
  })
}

export async function clickButton(page, name) {
  const btn = page.getByRole('button', { name, exact: true })
  await btn.scrollIntoViewIfNeeded().catch(() => {})
  await btn.click({ timeout: 15000 })
}

/** Nach „Weiter": warten, bis ein anderer Schritt da ist. false, wenn die Seite
 *  stehen bleibt (meist Validierungsfehler). */
export async function waitStepChange(page, beforeKey, timeout = 60000) {
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
export async function fieldId(page, label, prefix = false) {
  return page.evaluate(([label, prefix]) => {
    const norm = (s) => String(s ?? '').replace(/\*/g, '').replace(/\s+/g, ' ').trim()
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
    for (const l of document.querySelectorAll('label[for]')) {
      const t = norm(l.innerText)
      if (prefix ? t.startsWith(label) : t === label) {
        const el = document.getElementById(l.htmlFor)
        if (el && vis(el) && /^(INPUT|TEXTAREA)$/.test(el.tagName) && !/^(radio|checkbox)$/.test(el.type)) return l.htmlFor
      }
    }
    return null
  }, [label, prefix])
}

export async function fillText(page, label, value, { prefix = false, optional = false, suggest = false, max: maxLen = 0 } = {}) {
  if (value == null || value === '') return
  const id = await fieldId(page, label, prefix)
  if (!id) {
    if (optional) return
    throw new Error(`Feld „${label}" nicht gefunden.`)
  }
  const loc = page.locator(`[id="${id}"]`)
  const max = Number(await loc.getAttribute('maxlength'))
  const safe = portalSafe(value)
  const limit = max > 0 ? max : maxLen
  const text = limit > 0 ? safe.slice(0, limit) : safe
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  await loc.fill(text)
  if (suggest) await loc.press('Escape').catch(() => {})
  await loc.press('Tab')
}

/** select2-Auswahl über die sichtbare Oberfläche (GWT hört auf deren Events). */
export async function select2(page, label, option) {
  if (!option) return
  const box = page.locator('.combobox').filter({ has: page.locator('label', { hasText: label }) }).first()
  const combo = box.locator('[role=combobox]')
  await combo.scrollIntoViewIfNeeded().catch(() => {})
  await combo.click()
  const search = page.locator('.select2-container--open .select2-search__field')
  if (typeof option === 'string' && (await search.count()) && (await search.first().isVisible())) await search.first().fill(option)
  const re = option instanceof RegExp ? option : new RegExp(`^\\s*${escapeRe(option)}\\s*$`)
  const opt = page
    .locator('.select2-results__option')
    .filter({ hasText: re })
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
export async function visibleRadios(page) {
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

export async function clickRadioId(page, id) {
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

export const matches = (text, cand) => {
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

export const isYesNo = (group) => group.length === 2 && group.some((o) => o.text === 'Ja') && group.some((o) => o.text === 'Nein')

export function groupsOf(radios, used) {
  const groups = new Map()
  for (const r of radios) {
    if (used.has(r.name)) continue
    if (!groups.has(r.name)) groups.set(r.name, [])
    groups.get(r.name).push(r)
  }
  return [...groups.entries()].filter(([, opts]) => !isYesNo(opts))
}

/** Nach einer manuellen Auswahl: die gewählte, bisher unbenutzte Gruppe merken. */
export async function adoptManualChoice(page, used) {
  for (const [name, opts] of groupsOf(await visibleRadios(page), used)) {
    if (opts.some((o) => o.checked)) {
      used.add(name)
      return opts.find((o) => o.checked).text
    }
  }
  return null
}

export async function choosePathElement(run, page, el, used) {
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
export async function answerBehinderung(run, page, p) {
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
  // Pflichttext, sobald sichtbar (Frankfurt: nach „Ja"; Wiesbaden: bei der
  // Fußgängerfurt immer, ohne Ja/Nein-Frage).
  await sleep(500)
  const text = p.behinderung.text || (p.behinderung.ja ? 'Siehe Beweisfotos.' : 'Keine weitere Behinderung beobachtet, siehe Beweisfotos.')
  await fillText(page, 'Bitte beschreiben Sie die Behinderung', text, { prefix: true, optional: true })
}

// ---------------------------------------------------------------------------
// Uploads

/** Anzahl hochgeladener Dateien je Upload-Bereich (in Seitenreihenfolge). */
export async function uploadedCounts(page) {
  const t = await pageText(page)
  return [...t.matchAll(/hochgeladen:\s*(\d+|keine)/gi)].map((m) => (m[1] === 'keine' ? 0 : Number(m[1])))
}

export async function uploadSection(run, page, index, sectionLabel, files) {
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
// Checkboxen (RLP: Einwilligungen/Bestätigungen)

/** Checkbox per Label-Präfix setzen (JS-Klick, dann prüfen). */
export async function checkBox(page, labelPrefix) {
  const ok = await page.evaluate((t) => {
    const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
    for (const i of document.querySelectorAll('input[type=checkbox]')) {
      const l = document.querySelector(`label[for="${i.id}"]`)
      const r = (l || i).getBoundingClientRect()
      if (!l || !(r.width > 0) || !norm(l.innerText).startsWith(t)) continue
      i.scrollIntoView({ block: 'center' })
      if (!i.checked) i.click()
      return i.checked
    }
    return null
  }, labelPrefix)
  if (ok === null) throw new Error(`Häkchen „${labelPrefix.slice(0, 40)} …" nicht gefunden.`)
  if (!ok) throw new Error(`Häkchen „${labelPrefix.slice(0, 40)} …" ließ sich nicht setzen.`)
  await sleep(500)
}

/** Ja/Nein-Gruppe, deren Name (Frage) mit `frage` beginnt, beantworten. */
export async function answerYesNo(page, frage, ja) {
  const radios = await visibleRadios(page)
  const groups = new Map()
  for (const r of radios) {
    if (!groups.has(r.name)) groups.set(r.name, [])
    groups.get(r.name).push(r)
  }
  for (const [name, opts] of groups) {
    if (isYesNo(opts) && norm(name).startsWith(frage)) {
      await clickRadioId(page, opts.find((o) => o.text === (ja ? 'Ja' : 'Nein')).id)
      return true
    }
  }
  // Fallback: die einzige Ja/Nein-Gruppe auf der Seite
  const yn = [...groups.values()].filter(isYesNo)
  if (yn.length === 1) {
    await clickRadioId(page, yn[0].find((o) => o.text === (ja ? 'Ja' : 'Nein')).id)
    return true
  }
  throw new Error(`Frage „${frage}" nicht gefunden.`)
}

/** Datum in ein GWT-DateBox-Feld tippen (Kalender-Popup danach schließen). */
export async function fillDate(page, label, value) {
  const id = await fieldId(page, label)
  if (!id) throw new Error(`Feld „${label}" nicht gefunden.`)
  const date = page.locator(`[id="${id}"]`)
  await date.click()
  await date.fill(value)
  await date.press('Tab')
  await page.keyboard.press('Escape').catch(() => {})
}

// ---------------------------------------------------------------------------
// Ablauf

/** Füllt alles bis zur Zusammenfassung aus. profile: { startUrl, isSummary(step),
 *  handler(step, page) → async fn | null | undefined (undefined = unbekannter Schritt) } */
export async function fillSteps(run, profile) {
  const { page } = run
  run.log('Portal wird geöffnet …')
  await page.goto(profile.startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await waitReady(page)

  const handled = new Set() // automatisch erledigte Schritte
  const manual = new Set() // Schritte, die der Nutzer selbst ausgefüllt hat
  const ctx = { used: new Set() } // beantwortete Radio-Gruppen u.Ä. über Schritte hinweg

  for (let guard = 0; guard < 40; guard++) {
    run.check()
    const step = await currentStep(page)
    const key = stepKey(step)
    run.setStep(step)
    if (profile.isSummary(step)) return

    if (!handled.has(key) && !manual.has(key)) {
      run.log(`Schritt ${step.n}: ${step.title}`)
      try {
        const fn = await profile.handler(step, page)
        if (fn === undefined) throw new Error(`Unbekannter Schritt „${step.title}".`)
        if (fn) await fn(run, page, run.payload, ctx)
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
      // Beide Prüfseiten enthalten „Bitte prüfen Sie Ihre Angaben" – erst ein
      // anderer Schritt ohne diesen Text ist die Abschlussseite.
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

/** Text eines PDFs (pdftotext -layout; leer, wenn das Werkzeug fehlt). */
export async function pdfText(buffer) {
  const { spawn } = await import('node:child_process')
  return new Promise((resolve) => {
    const p = spawn('pdftotext', ['-layout', '-', '-'])
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', () => resolve(''))
    p.on('close', () => resolve(out))
    p.stdin.on('error', () => {})
    p.stdin.end(buffer)
  })
}

/** Vorgangs-ID aus der PDF-Zusammenfassung: Fußzeile
 *  „Vorgang: Anzeige einer Ordnungswidrigkeit / 26.111745" (ekom21, Stand 10/2026). */
export async function vorgangsIdAusPdf(buffer) {
  const text = await pdfText(buffer)
  const m = text.match(/Vorgang:[^\n/]*\/\s*(\d{2}\.\d{3,})/) || text.match(/Vorgangs-?(?:ID|nummer)\s*:?\s*([A-Za-z0-9][A-Za-z0-9.\-/]{3,})/i)
  return m ? m[1] : null
}

/** PDF-Zusammenfassung der Abschlussseite holen (Download oder neues Fenster). */
export async function downloadReceipt(run) {
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
