import fs from 'fs/promises'
import path from 'path'
import { PDFDocument, PDFName, PDFArray, StandardFonts, degrees, rgb } from 'pdf-lib'
import { readOrientation } from './pixelate'
import mysql from 'mysql2/promise'
import type { ReportImage } from '../routes/reports'
import { getCity, DEFAULT_CITY_ID } from '../config/cities'
import { renderTatortMap } from './staticmap'

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

  async generate(
    report: mysql.RowDataPacket,
    user: mysql.RowDataPacket,
    images: ReportImage[] = []
  ): Promise<string> {
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

    const A4 = { width: 595.28, height: 841.89 }
    const margin = 40

    // Tatort-Karte mit Marker als eigene Seite (vor den Beweisfotos), sofern
    // Koordinaten vorliegen und der Tileserver die Kacheln liefern kann.
    if (report.tatort_lat != null && report.tatort_lon != null) {
      try {
        const mapPng = await renderTatortMap(Number(report.tatort_lat), Number(report.tatort_lon))
        if (mapPng) {
          const embedded = await doc.embedPng(mapPng)
          const font = await doc.embedFont(StandardFonts.Helvetica)
          const page = doc.addPage([A4.width, A4.height])
          let cursorY = A4.height - margin

          page.drawText('Tatort auf der Karte', { x: margin, y: cursorY - 14, size: 14, font })
          cursorY -= 32
          if (report.tatort) {
            // Adresse als Bildunterschrift; WinAnsi kann keine Emojis o.Ä. – daher absichern.
            try {
              page.drawText(String(report.tatort), { x: margin, y: cursorY - 10, size: 10, font })
              cursorY -= 26
            } catch {
              /* Sonderzeichen in der Adresse – Unterschrift weglassen */
            }
          }

          const scaled = embedded.scaleToFit(A4.width - margin * 2, cursorY - margin)
          page.drawImage(embedded, {
            x: (A4.width - scaled.width) / 2,
            y: cursorY - scaled.height,
            width: scaled.width,
            height: scaled.height,
          })
        }
      } catch {
        // Karte konnte nicht erzeugt werden — PDF ohne Kartenseite weiter.
      }
    }

    // Hochgeladene Bilder als zusätzliche Seiten anhängen. PDF-Viewer ignorieren
    // die EXIF-Orientation (Handys speichern Hochkant-Fotos quer + Dreh-Tag);
    // deshalb wird das Bild hier beim Zeichnen entsprechend gedreht. Oben je Seite
    // die Aufnahmezeit (aus EXIF) als Beschriftung – wichtiges Beweis-Detail.
    const photoFont = await doc.embedFont(StandardFonts.Helvetica)
    for (const image of images) {
      try {
        const embedded =
          image.mimetype === 'image/png'
            ? await doc.embedPng(image.buffer)
            : await doc.embedJpg(image.buffer)
        const orientation = await readOrientation(image.buffer)
        const page = doc.addPage([A4.width, A4.height])

        // Beschriftung oben: reserviert eine Kopfzeile, das Bild sitzt darunter.
        const caption = image.capturedAt ? `Aufgenommen: ${image.capturedAt} Uhr` : null
        const captionH = caption ? 22 : 0
        if (caption) {
          page.drawText(caption, {
            x: margin,
            y: A4.height - margin - 11,
            size: 11,
            font: photoFont,
            color: rgb(0.1, 0.1, 0.1),
          })
        }

        // Anzeige-Maße: bei 90°-Drehungen (Orientation 5-8) sind Breite/Höhe vertauscht.
        const rot90 = orientation >= 5
        const dispW = rot90 ? embedded.height : embedded.width
        const dispH = rot90 ? embedded.width : embedded.height
        // Verfügbare Fläche = Seite minus Ränder minus Kopfzeile (Beschriftung).
        const availH = A4.height - margin * 2 - captionH
        const s = Math.min((A4.width - margin * 2) / dispW, availH / dispH)
        const w = embedded.width * s // gezeichnete Maße in gespeicherter Orientierung
        const h = embedded.height * s
        const bx = (A4.width - dispW * s) / 2 // Ziel-Box (aufrechtes Bild), horizontal zentriert
        const by = margin + (availH - dispH * s) / 2 // vertikal in der Fläche unter der Kopfzeile

        // pdf-lib dreht um den Punkt (x,y); x/y so wählen, dass das gedrehte
        // Bild exakt in der Ziel-Box landet. Spiegel-Orientierungen (2,4,5,7)
        // werden wie ihre Dreh-Entsprechung behandelt.
        if (orientation === 3 || orientation === 4) {
          page.drawImage(embedded, { x: bx + w, y: by + h, width: w, height: h, rotate: degrees(180) })
        } else if (orientation === 5 || orientation === 6) {
          page.drawImage(embedded, { x: bx, y: by + w, width: w, height: h, rotate: degrees(-90) })
        } else if (orientation === 7 || orientation === 8) {
          page.drawImage(embedded, { x: bx + h, y: by, width: w, height: h, rotate: degrees(90) })
        } else {
          page.drawImage(embedded, { x: bx, y: by, width: w, height: h })
        }
      } catch {
        // Bild konnte nicht eingebettet werden — überspringen
      }
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
