import fs from 'fs/promises'
import path from 'path'
import { PDFDocument, PDFName, PDFArray, StandardFonts, rgb } from 'pdf-lib'
import mysql from 'mysql2/promise'
import { getCity, DEFAULT_CITY_ID } from '../config/cities'

/** "14:30:00" / "14:30" -> "14:30" */
function hhmm(time: unknown): string {
  if (!time) return ''
  return String(time).slice(0, 5)
}

const RESOURCES_DIR = path.join(process.cwd(), 'resources')
const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs')

/** Pfad zum amtlichen Formular der jeweiligen Stadt. Städte ohne Formular werden
 *  als rohe E-Mail versendet – hier darf der PDF-Service dann nicht landen. */
function formPath(cityId?: string | null): string {
  const city = getCity(cityId)
  if (!city.pdfForm) {
    throw new Error(`Stadt „${city.id}" hat kein PDF-Formular (Versand erfolgt als rohe E-Mail).`)
  }
  return path.join(RESOURCES_DIR, city.pdfForm)
}

export const PdfService = {
  /**
   * Gibt alle AcroForm-Feldnamen des Frankfurt-Formulars aus.
   * Einmalig aufrufen um die Feldnamen zu ermitteln.
   */
  async listFields(cityId: string = DEFAULT_CITY_ID): Promise<string[]> {
    const bytes = await fs.readFile(formPath(cityId))
    const doc = await PDFDocument.load(bytes)
    const form = doc.getForm()
    return form.getFields().map((f) => `${f.constructor.name}: ${f.getName()}`)
  },

  /** Nur das ausgefüllte amtliche Formular – Beweisfotos gehen als eigene
   *  Mail-Anhänge raus (MailService.prepareReport), eine Kartenseite gibt es nicht. */
  async generate(report: mysql.RowDataPacket, user: mysql.RowDataPacket): Promise<string> {
    const userDir = path.join(PDF_DIR, String(user.id))
    await fs.mkdir(userDir, { recursive: true })

    const bytes = await fs.readFile(formPath(report.city))
    const doc = await PDFDocument.load(bytes)
    const form = doc.getForm()

    const fmtDate = (d: Date) =>
      d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const tattag = report.tattag ? new Date(report.tattag) : null
    const tattagBis = report.tattag_bis ? new Date(report.tattag_bis) : null
    // Tatzeitraum über Mitternacht (z.B. Dauerparken über Nacht): das Formular
    // hat nur EIN Tattag-Feld – dort steht dann der Datumsbereich; zusammen mit
    // der Uhrzeit "von – bis" ist der Zeitraum eindeutig.
    const tatwdate = tattag
      ? tattagBis && fmtDate(tattagBis) !== fmtDate(tattag)
        ? `${fmtDate(tattag)} – ${fmtDate(tattagBis)}`
        : fmtDate(tattag)
      : ''
    const von = hhmm(report.tatzeit_von)
    const bis = hhmm(report.tatzeit_bis)
    // Kein "ab ..." zulässig: entweder Zeitraum oder feste Uhrzeit.
    const tattime =
      von && bis ? `${von} – ${bis} Uhr` : von ? `${von} Uhr` : bis ? `${bis} Uhr` : ''

    const heute = new Date().toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })

    // Tatvorwurf und Beschreibung gehören in EIN Feld (die Sachverhalts-
    // schilderung). Das davorliegende Feld "Angaben zum Tatvorwurf" ist
    // unbrauchbar und bleibt leer.
    const sachverhalt = [
      report.verstoss_art,
      report.fahrzeug_verlassen === 1 ? 'Das Fahrzeug war verlassen.' : '',
      report.beschreibung,
    ]
      .filter((v) => v && String(v).trim())
      .join('\n\n')

    // Schlüssel = exakte AcroForm-Feldnamen des Frankfurt-Formulars
    // (ermittelt via PdfService.listFields() bzw. GET /debug/pdf-fields).
    // "Weitere Zeugen" bleibt ungenutzt, da hierfür keine Daten erfasst werden.
    const fieldMap: Record<string, string> = {
      // Anzeigeerstatter
      Name: user.nachname || '',
      Vorname: user.vorname || '',
      'Straße Hausnummer': user.strasse || '',
      PLZ: user.plz || '',
      Ort: user.ort || '',
      Telefon: user.telefon || '',
      EMail: user.email || '',
      // Tat — Tatvorwurf + Beschreibung gemeinsam in der Sachverhaltsschilderung,
      // das Feld "Angaben zum Tatvorwurf" bleibt ungenutzt (unbrauchbar).
      'Tatvorwurf  Sachverhaltsschilderung ggf vorhandene Beschilderung': sachverhalt,
      'Tatort Straße Hausnummer': report.tatort || '',
      'Tattag Datum': tatwdate,
      'Tatzeit Uhrzeit von wann bis wann': tattime,
      // Ausländische Kennzeichen: Länderkürzel als Zusatz (Default 'D' bleibt weg).
      'Kennzeichen des betroffenen Fahrzeuges':
        (report.kennzeichen || '') +
        (report.kennzeichen && report.kennzeichen_land && report.kennzeichen_land !== 'D'
          ? ` (${report.kennzeichen_land})`
          : ''),
      'Marke und Farbe des betroffenen Fahrzeuges': report.fahrzeug_marke || '',
      // Behinderung: Beschreibung "wer wurde wie behindert" (nur bei „Ja")
      'Wurde jemand behindert ja wer wurde wie behindert nein':
        report.behinderung === 1 ? report.behinderung_text || '' : '',
      // Unterschriftszeile
      'Ort Datum': user.ort ? `${user.ort}, ${heute}` : heute,
    }

    for (const [fieldName, value] of Object.entries(fieldMap)) {
      try {
        const field = form.getTextField(fieldName)
        field.setText(value)
      } catch {
        // Feld existiert nicht im Formular — nach Inspektion anpassen
      }
    }

    // "Wurde jemand behindert?" – ja/nein-Ankreuzfelder. Die beiden Checkboxen
    // heißen im Formular "undefined" (ja, links) und "undefined_2" (nein, rechts).
    // Standard ist "Nein" – es ist also immer eine der beiden angekreuzt.
    // Die "On"-Appearance der Formular-Checkboxen zeichnet nichts Sichtbares,
    // deshalb wird zusätzlich ein Kreuz direkt an der Widget-Position gemalt.
    try {
      const box = form.getCheckBox(report.behinderung === 1 ? 'undefined' : 'undefined_2')
      box.check()
      const rect = box.acroField.getWidgets()[0]?.getRectangle()
      if (rect) {
        const font = await doc.embedFont(StandardFonts.HelveticaBold)
        const size = Math.min(rect.height, rect.width) * 1.1
        doc.getPage(0).drawText('X', {
          x: rect.x + (rect.width - font.widthOfTextAtSize('X', size)) / 2,
          y: rect.y + (rect.height - font.heightAtSize(size) * 0.72) / 2,
          size,
          font,
        })
      }
    } catch {
      // Checkbox nicht gefunden — ignorieren
    }

    // Das Frankfurt-Formular ist defekt: seine Feld-Widgets stehen nicht im
    // /Annots-Array der Seite. Dadurch rendert KEIN Viewer die eingetragenen
    // Werte (Texte und Häkchen bleiben unsichtbar) und flatten() scheitert mit
    // "Could not find page for PDFRef". Die Widgets werden deshalb vor dem
    // Flatten an die erste Seite gehängt.
    try {
      const pageNode = doc.getPage(0).node
      let annots = pageNode.lookupMaybe(PDFName.of('Annots'), PDFArray)
      if (!annots) {
        annots = doc.context.obj([])
        pageNode.set(PDFName.of('Annots'), annots)
      }
      const known = new Set<string>()
      for (let i = 0; i < annots.size(); i++) known.add(String(annots.get(i)))
      for (const field of form.getFields()) {
        for (const widget of field.acroField.getWidgets()) {
          const ref = doc.context.getObjectRef(widget.dict)
          if (ref && !known.has(String(ref))) annots.push(ref)
        }
      }
    } catch {
      /* Reparatur fehlgeschlagen – flatten unten versucht es trotzdem */
    }

    // Eingetragene Werte in Schwarz statt der grauen Default-Schrift des
    // Formulars: Default-Appearance aller Felder auf "0 g" (schwarz) setzen
    // und die Appearances damit neu erzeugen.
    try {
      const fieldFont = await doc.embedFont(StandardFonts.Helvetica)
      for (const field of form.getFields()) {
        try {
          field.acroField.setDefaultAppearance('/Helv 10 Tf 0 g')
        } catch {
          /* Feld ohne DA – egal */
        }
      }
      form.updateFieldAppearances(fieldFont)
    } catch {
      /* Appearances bleiben wie sie sind */
    }

    // Felder „einbrennen", damit sie nicht mehr veränderbar sind und in jedem
    // Viewer/Druck sichtbar sind.
    try {
      form.flatten()
    } catch {
      try {
        form.updateFieldAppearances()
      } catch {
        /* Appearances konnten nicht aktualisiert werden – egal */
      }
    }

    // Vermerk oben rechts auf dem Formular: ausgefüllt über owia.treudler.net
    // plus unser Aktenzeichen (zur Zuordnung bei Rückfragen). Nach dem Flatten
    // gezeichnet, damit der Text sicher über dem Formular liegt.
    try {
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const first = doc.getPage(0)
      const { width, height } = first.getSize()
      const size = 8
      const edge = 24
      const lines = [
        'Ausgefüllt mit owia.treudler.net.',
        `Aktenzeichen: ${report.aktenzeichen || ''}`,
      ]
      let y = height - edge
      for (const line of lines) {
        first.drawText(line, {
          x: width - edge - font.widthOfTextAtSize(line, size),
          y,
          size,
          font,
        })
        // Leerzeile zwischen den beiden Zeilen (wie im Vermerk-Layout gewünscht).
        y -= size * 2.4
      }
    } catch {
      // Vermerk konnte nicht gezeichnet werden — PDF trotzdem erzeugen.
    }

    // Seitenzahl "Seite X von Y" unten rechts auf jeder Seite (auch dem Formular).
    try {
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const pages = doc.getPages()
      pages.forEach((page, i) => {
        const label = `Seite ${i + 1} von ${pages.length}`
        const size = 8
        page.drawText(label, {
          x: page.getSize().width - 24 - font.widthOfTextAtSize(label, size),
          y: 12,
          size,
          font,
          color: rgb(0.35, 0.35, 0.35),
        })
      })
    } catch {
      // Seitenzahlen sind nice-to-have – PDF trotzdem erzeugen.
    }

    const filled = await doc.save()

    // Dateiname = Präfix-Tattag-Nummer (z.B. "OWiA-2026-07-14-123456.pdf"):
    // sortiert sich chronologisch und trägt das Aktenzeichen. Tattag bewusst
    // aus den lokalen Datums-Komponenten (kein toISOString – das würde je nach
    // Server-Zeitzone einen Tag verrutschen).
    let filename = `anzeige-${report.id}.pdf`
    if (report.aktenzeichen) {
      let datum = ''
      if (report.tattag) {
        const t = new Date(report.tattag)
        if (!isNaN(t.getTime())) {
          const pad = (n: number) => String(n).padStart(2, '0')
          datum = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}-`
        }
      }
      // Erster Bindestrich trennt Präfix und Nummer: "OWiA-123456" -> "OWiA-<datum>-123456".
      filename = `${String(report.aktenzeichen).replace('-', `-${datum}`)}.pdf`
    }
    await fs.writeFile(path.join(userDir, filename), filled)
    return filename
  },
}
