import fs from 'fs/promises'
import path from 'path'
import { PDFDocument } from 'pdf-lib'
import mysql from 'mysql2/promise'
import type { ReportImage } from '../routes/reports'

/** "14:30:00" / "14:30" -> "14:30" */
function hhmm(time: unknown): string {
  if (!time) return ''
  return String(time).slice(0, 5)
}

const FORM_PATH = path.join(process.cwd(), 'resources', 'formular.pdf')
const PDF_DIR = path.join(process.cwd(), 'data', 'pdfs')

export const PdfService = {
  /**
   * Gibt alle AcroForm-Feldnamen des Frankfurt-Formulars aus.
   * Einmalig aufrufen um die Feldnamen zu ermitteln.
   */
  async listFields(): Promise<string[]> {
    const bytes = await fs.readFile(FORM_PATH)
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

    const bytes = await fs.readFile(FORM_PATH)
    const doc = await PDFDocument.load(bytes)
    const form = doc.getForm()

    const tattag = report.tattag ? new Date(report.tattag) : null
    const tatwdate = tattag
      ? tattag.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : ''
    const von = hhmm(report.tatzeit_von)
    const bis = hhmm(report.tatzeit_bis)
    const tattime = von && bis ? `${von} – ${bis} Uhr` : von ? `ab ${von} Uhr` : ''

    const heute = new Date().toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    })

    // Schlüssel = exakte AcroForm-Feldnamen des Frankfurt-Formulars
    // (ermittelt via PdfService.listFields() bzw. GET /debug/pdf-fields).
    // Die beiden namenlosen PDFCheckBox-Felder ("behindert ja/nein") sowie
    // "Weitere Zeugen" und das Behinderungs-Textfeld bleiben ungenutzt,
    // da hierfür keine Daten erfasst werden.
    const fieldMap: Record<string, string> = {
      // Anzeigeerstatter
      Name: user.nachname || '',
      Vorname: user.vorname || '',
      'Straße Hausnummer': user.strasse || '',
      PLZ: user.plz || '',
      Ort: user.ort || '',
      Telefon: user.telefon || '',
      EMail: user.email || '',
      // Tat
      'Angaben zum Tatvorwurf': report.verstoss_art || '',
      'Tatvorwurf  Sachverhaltsschilderung ggf vorhandene Beschilderung':
        report.beschreibung || '',
      'Tatort Straße Hausnummer': report.tatort || '',
      'Tattag Datum': tatwdate,
      'Tatzeit Uhrzeit von wann bis wann': tattime,
      'Kennzeichen des betroffenen Fahrzeuges': report.kennzeichen || '',
      'Marke und Farbe des betroffenen Fahrzeuges': report.fahrzeug_marke || '',
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

    form.flatten()

    // Hochgeladene Bilder als zusätzliche Seiten anhängen
    const A4 = { width: 595.28, height: 841.89 }
    const margin = 40
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
