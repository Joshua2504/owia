// Mainz: „Anzeige einer Verkehrsordnungswidrigkeit im ruhenden Verkehr"
// (civento auf antrag-kommunal.service.rlp.de, Verkehrsüberwachungsamt).
// Seit 22.05.2025 nimmt Mainz Privatanzeigen nur noch über dieses Formular an.
// Stand 10/2026, 10 Schritte; erkundet in /root/owia/work/mainz/BERICHT.md.
//
// Anders als ekom21: Einwilligung (2 Häkchen), Authentifizierung und
// Personendaten als zwei Schritte gleichen Titels, Zeugen-Frage, flache
// Tatbestandsauswahl (Art × 11 Rubriken + ein Freitext ≤ 1000 Zeichen für alle
// Details), Tatort in PLZ/Ort/Straße + Hausnummer oder Beschreibung, ein
// Upload-Bereich mit höchstens 3 Fotos, Bestätigungen als Häkchen.
// PLZ/Ort/Straße sind GWT-SuggestBoxen: nach dem Tippen Popup per Escape schließen.

import {
  choosePathElement, select2, fillText, fillDate, visibleRadios, clickRadioId, uploadSection,
  checkBox, answerYesNo, escapeRe,
} from './lib.mjs'

const START = 'https://antrag-kommunal.service.rlp.de/civ.public/start.html?oe=00.00.MZ.01.31.01&mode=cc&cc_key=AnzeigeVerkehrsordnungswidrigkeit'

async function stepEinwilligung(run, page) {
  await checkBox(page, 'Ich habe die')
  await checkBox(page, 'Ich bin damit einverstanden')
  run.log('Einwilligungen bestätigt')
}

async function stepPerson(run, page, p) {
  const ohne = (await visibleRadios(page)).find((r) => r.text.startsWith('ohne Nutzerkonto'))
  if (ohne) {
    await clickRadioId(page, ohne.id)
    run.log('Authentifizierung: ohne Nutzerkonto')
    return
  }
  const a = p.person
  if (a.anrede) await select2(page, 'Anrede', a.anrede).catch(() => {})
  await fillText(page, 'Name', a.name)
  await fillText(page, 'Vorname', a.vorname)
  await fillText(page, 'Postleitzahl', a.plz, { suggest: true })
  await fillText(page, 'Ort', a.ort, { suggest: true })
  await fillText(page, 'Straße/Postfach', a.strasse, { suggest: true })
  await fillText(page, 'Nr.', a.nr)
  await fillText(page, 'E-Mail-Adresse', a.email)
  await fillText(page, 'E-Mail-Adresse bestätigen', a.email)
  await fillText(page, 'Telefonnummer', a.telefon)
  run.log(`Anzeigende Person: ${a.vorname} ${a.name}, ${a.strasse} ${a.nr}, ${a.plz} ${a.ort}`)
}

async function stepZusatz(run, page) {
  await answerYesNo(page, 'Angaben weitere Zeugin', false)
  run.log('Weitere Zeugen: Nein')
}

async function stepAngaben(run, page, p, ctx) {
  const t = p.tat
  await fillDate(page, 'Tag (Tattag)', t.tattag)
  await fillText(page, 'von: hh:mm', t.von)
  await fillText(page, 'bis: hh:mm', t.bis)
  await choosePathElement(run, page, { pick: [p.mz.art] }, ctx.used)
  // Tatort
  await fillText(page, 'Postleitzahl', t.plz, { suggest: true })
  await fillText(page, 'Ort', t.ortName, { suggest: true })
  await fillText(page, 'Straße/Postfach', t.strasse, { suggest: true })
  if (t.hausnummer) {
    await choosePathElement(run, page, { pick: ['Hausnummer'] }, ctx.used)
    await fillText(page, 'Hausnummer', t.hausnummer)
  } else {
    await choosePathElement(run, page, { pick: ['Sonstige Beschreibung der Örtlichkeit'] }, ctx.used)
    await fillText(page, 'Beschreibung der Örtlichkeit', t.beschreibung || t.strasse)
  }
  // Fahrzeug: Land über das Kürzel in Klammern („Deutschland (D)")
  const f = p.fahrzeug
  await select2(page, 'Kennzeichen Land', new RegExp(`\\(${escapeRe(f.landCode || 'D')}\\)\\s*$`))
  await fillText(page, 'KFZ-Kennzeichen', f.kennzeichen)
  if (f.typ) await select2(page, 'Fahrzeugtyp', f.typ).catch(() => run.log(`Fahrzeugtyp „${f.typ}" nicht in der Liste – leer gelassen`))
  if (f.marke) {
    try {
      await select2(page, 'Marke des Fahrzeugs', f.marke)
    } catch {
      await select2(page, 'Marke des Fahrzeugs', 'Sonstiges').catch(() => {})
      await fillText(page, 'Sonstige Marke', f.marke, { optional: true })
    }
  }
  await fillText(page, 'Farbe', f.farbe, { optional: true })
  run.log(`Tat: ${t.tattag} ${t.von}–${t.bis}, ${p.mz.art}, ${t.strasse} ${t.hausnummer || ''}, ${t.plz} ${t.ortName}; Fahrzeug ${f.kennzeichen}`)
}

async function stepAuswahl(run, page, p, ctx) {
  await choosePathElement(run, page, p.mz.rubrik ? { pick: [p.mz.rubrik] } : { manual: true, hint: 'Bitte die passende Ordnungswidrigkeit im Live-Bild auswählen.' }, ctx.used)
  await fillText(page, 'Hier können Sie die Ordnungswidrigkeit näher beschreiben', p.mz.freitext, { prefix: true, max: 1000 })
}

async function stepBestaetigung(run, page) {
  await checkBox(page, 'Die Ordnungswidrigkeit wurde von mir persönlich')
  await checkBox(page, 'Ich versichere')
  run.log('Beobachtung und Richtigkeit bestätigt')
}

async function stepDokumente(run, page) {
  // Höchstens 3 Dateien – mehr in einer Auswahl verwirft das Portal komplett.
  const files = [...run.files.uebersicht, ...run.files.fahrzeug].slice(0, 3)
  await uploadSection(run, page, 0, 'Foto(s) der Ordnungswidrigkeit', files)
}

export const PROFILE = {
  'civento-mz': {
    startUrl: START,
    isSummary: (step) => /Eingaben kontrollieren/.test(step.title),
    handler: (step) => ({
      Startseite: null,
      Einwilligungserklärung: stepEinwilligung,
      'Daten der antragstellenden Person': stepPerson,
      'Zusätzliche Daten': stepZusatz,
      'Angaben zu Ordnungswidrigkeiten': stepAngaben,
      'Ordnungswidrigkeit auswählen': stepAuswahl,
      'Bestätigungen zur Privatanzeige': stepBestaetigung,
      'Dokumente hochladen': stepDokumente,
    })[step.title],
  },
}
