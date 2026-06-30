import fs from 'fs/promises'
import path from 'path'
import { PDFDocument, StandardFonts } from 'pdf-lib'
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

/** Pfad zum amtlichen Formular der jeweiligen Stadt. */
function formPath(cityId?: string | null): string {
  return path.join(RESOURCES_DIR, getCity(cityId).pdfForm)
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

    const tattag = report.tattag ? new Date(report.tattag) : null
    const tatwdate = tattag
      ? tattag.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
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
    const sachverhalt = [report.verstoss_art, report.beschreibung]
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
      'Kennzeichen des betroffenen Fahrzeuges': report.kennzeichen || '',
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
    // behinderung: 1=ja, 0=nein, null=keine Angabe (dann bleibt nichts angekreuzt).
    try {
      if (report.behinderung === 1) form.getCheckBox('undefined').check()
      else if (report.behinderung === 0) form.getCheckBox('undefined_2').check()
    } catch {
      // Checkbox nicht gefunden — ignorieren
    }

    // Felder „einbrennen", damit sie nicht mehr veränderbar sind. Manche
    // Formulare (verwaiste Widget-Annotationen) lassen sich von pdf-lib nicht
    // flatten ("Could not find page for PDFRef"). Dann bleiben die Felder
    // ausfüllbar, zeigen aber die gesetzten Werte – PDF wird trotzdem erzeugt.
    try {
      form.flatten()
    } catch {
      try {
        form.updateFieldAppearances()
      } catch {
        /* Appearances konnten nicht aktualisiert werden – egal */
      }
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

    // Hochgeladene Bilder als zusätzliche Seiten anhängen
    for (const image of images) {
      try {
        const embedded =
          image.mimetype === 'image/png'
            ? await doc.embedPng(image.buffer)
            : await doc.embedJpg(image.buffer)
        const page = doc.addPage([A4.width, A4.height])
        const scaled = embedded.scaleToFit(A4.width - margin * 2, A4.height - margin * 2)
        page.drawImage(embedded, {
          x: (A4.width - scaled.width) / 2,
          y: (A4.height - scaled.height) / 2,
          width: scaled.width,
          height: scaled.height,
        })
      } catch {
        // Bild konnte nicht eingebettet werden — überspringen
      }
    }

    const filled = await doc.save()

    const filename = `anzeige-${report.id}-${Date.now()}.pdf`
    await fs.writeFile(path.join(userDir, filename), filled)
    return filename
  },
}
