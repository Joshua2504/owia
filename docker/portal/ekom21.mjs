// ekom21-Vorlage „Anzeige einer Verkehrsordnungswidrigkeit" (cc_key=AnzeigeOwi)
// – Frankfurt (Stand 10/2026, 8 Schritte) und Wiesbaden (7 Schritte, anders
// konfiguriert). Bausteine in lib.mjs.
//
// Frankfurt: Rubrik + Fahrzeug in „Angaben der Ordnungswidrigkeiten", der
//   Tatbestand-Baum (Halten/Parken/… → Stelle → Behinderung) im eigenen Schritt
//   „Ordnungswidrigkeiten Details". E-Mail freiwillig, kein Ergänzungsfeld.
// Wiesbaden: kein Details-Schritt – der Tatbestand (ein ganzer Satz) wird direkt
//   unter der Rubrik gewählt; „Sonstiges" verlangt eine Beschreibung des
//   Tatvorwurfs; E-Mail Pflicht; Feld „Ergänzende Angaben"; Tatort-Schritt mit
//   „Ort/Gemarkung" (vorbelegt).

import {
  choosePathElement, answerBehinderung, select2, fillText, fillDate, fieldId, visibleRadios, clickRadioId,
  uploadSection, sleep,
} from './lib.mjs'

const BASE = 'https://portal-civ.ekom21.de/civ.public/start.html?mode=cc&cc_key=AnzeigeOwi&oe='

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

async function fahrzeug(run, page, f) {
  await select2(page, 'Fahrzeugtyp', f.typ || 'PKW')
  // Auch „Deutschland" ausdrücklich wählen – vorausgewählt ist es nur optisch,
  // ohne Auswahl steht in der Zusammenfassung „Kennzeichen-Land: -".
  await select2(page, 'Kennzeichen Land', f.land || 'Deutschland')
  await fillText(page, 'Kennzeichen', f.kennzeichen)
  let modell = f.modell
  if (f.marke) {
    try {
      await select2(page, 'Marke des Fahrzeuges', f.marke)
    } catch {
      await select2(page, 'Marke des Fahrzeuges', 'Sonstiges').catch(() => {})
      modell = [f.marke, f.modell].filter(Boolean).join(' ')
    }
  }
  await fillText(page, 'Fahrzeugmodell', modell, { optional: true })
  await fillText(page, 'Farbe', f.farbe, { optional: true })
  run.log(`Fahrzeug: ${f.typ || 'PKW'} ${f.kennzeichen}${f.marke ? `, ${f.marke}` : ''}${f.farbe ? `, ${f.farbe}` : ''}`)
}

/** Tatbestand-Pfad abfahren (Radio-Gruppen), dann Pflicht-Freitexte. */
async function tatbestand(run, page, p, ctx) {
  // null = kein Mapping → Nutzer wählt; [] = Rubrik ohne Unterauswahl (Wiesbaden „Sonstiges").
  const pfad = Array.isArray(p.pfad) ? p.pfad : [{ manual: true, hint: 'Bitte den Tatbestand im Live-Bild vollständig auswählen.' }]
  for (const el of pfad) await choosePathElement(run, page, el, ctx.used)
  // Wiesbaden „Sonstiges": Pflichtbeschreibung des Tatvorwurfs.
  await sleep(400)
  await fillText(page, 'Bitte beschreiben Sie den Tatvorwurf', p.tatvorwurf, { prefix: true, optional: true })
  await answerBehinderung(run, page, p)
}

async function stepAngaben(run, page, p, ctx, { pfadHier }) {
  await choosePathElement(run, page, p.gruppe ? { pick: [p.gruppe] } : { manual: true, hint: 'Bitte die Rubrik der Ordnungswidrigkeit im Live-Bild auswählen.' }, ctx.used)
  if (pfadHier) await tatbestand(run, page, p, ctx)
  await fahrzeug(run, page, p.fahrzeug)
}

async function stepTat(run, page, p) {
  const t = p.tat
  await fillText(page, 'Straße und Hausnummer', t.ort, { prefix: true })
  await fillDate(page, 'Tattag (Datum)', t.tattag)
  // Je nach Tatbestand fragt das Portal Beginn/Ende ab oder (z. B. „hielten
  // … auf einem Radweg", 141070) nur einen Zeitpunkt „Tatzeit (Zeitpunkt)".
  if (await fieldId(page, 'Beginn Tatzeit', false)) {
    await fillText(page, 'Beginn Tatzeit', t.von)
    await fillText(page, 'Ende Tatzeit', t.bis)
    run.log(`Tat: ${t.ort}, ${t.tattag} ${t.von}–${t.bis}`)
  } else {
    await fillText(page, 'Tatzeit', t.von, { prefix: true })
    run.log(`Tat: ${t.ort}, ${t.tattag} ${t.von} (nur Zeitpunkt)`)
  }
  await uploadSection(run, page, 0, 'Beweis-Übersichtsfoto', run.files.uebersicht)
  await uploadSection(run, page, 1, 'Beweis-Fahrzeugfoto', run.files.fahrzeug)
}

async function stepVersicherung(run, page, p) {
  await fillText(page, 'Ihre E-Mail Adresse', p.email, { prefix: true, optional: true })
  // Wiesbaden: „Relevante Umstände, ergänzende Angaben zum Vorfall." (max. 1000)
  await fillText(page, 'Relevante Umstände', p.ergaenzend, { prefix: true, optional: true, max: 1000 })
  const r = (await visibleRadios(page)).find((x) => x.text.startsWith('Ich versichere'))
  if (!r) throw new Error('Versicherung der Richtigkeit nicht gefunden.')
  await clickRadioId(page, r.id)
  run.log('Richtigkeit versichert')
}

function profil(oe, { pfadHier }) {
  return {
    startUrl: BASE + oe,
    isSummary: (step) => /überprüfen Sie Ihre Angaben/.test(step.title),
    handler: (step) => ({
      Start: null,
      'Antragstellende Person': stepAntragsteller,
      'Angaben der Ordnungswidrigkeiten': (run, page, p, ctx) => stepAngaben(run, page, p, ctx, { pfadHier }),
      'Ordnungswidrigkeiten Details': (run, page, p, ctx) => tatbestand(run, page, p, ctx),
      'Angaben zur Tat': stepTat,
      'Versicherung der Richtigkeit der Angaben': stepVersicherung,
    })[step.title],
  }
}

export const PROFILE = {
  'ekom21-ffm': profil('00.00.PA.FFOrdA', { pfadHier: false }),
  'ekom21-wi': profil('00.00.PA.WIOrdA', { pfadHier: true }),
}
