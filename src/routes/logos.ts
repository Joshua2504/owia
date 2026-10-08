import { FastifyInstance } from 'fastify'
import { viewData } from '../middleware/auth'

// Logo-Entwürfe zur Auswahl. Die SVGs liegen in public/logos/ (je eine helle
// und eine -dunkel-Variante); öffentlich, aber per robots.txt ausgenommen.
const ENTWUERFE: Array<[slug: string, name: string, idee: string]> = [
  ['halteverbot-pin', 'Halteverbot-Pin', 'Halteverbotsschild im Standort-Pin: wo falsch geparkt wird.'],
  ['kennzeichen', 'Kennzeichen', 'Deutsches Nummernschild „OW·IA“ mit Plaketten.'],
  ['kamera-p', 'Kamera mit P', 'Kamera, deren Linse ein Parkplatz-P ist.'],
  ['sucher', 'Sucher', 'Kamera-Sucherecken um ein Auto, roter Aufnahmepunkt.'],
  ['monogramm-oa', 'Monogramm OA', 'O als blauer Ring, A in Rot – geometrisch, schildartig.'],
  ['stempel', 'Stempel', 'Behördenstempel „Ordnungswidrigkeit · Anzeige“.'],
  ['verbot-geprueft', 'Verbot + Häkchen', 'Halteverbotsschild mit grünem „erledigt“-Häkchen.'],
  ['lupe', 'Lupe', 'Lupe über einem Auto: genau hinsehen, belegen.'],
  ['sprechblase', 'Sprechblase', 'Rote Meldung mit Ausrufezeichen.'],
  ['fussgaenger', 'Fußgänger', 'Gehweg frei: Fußgänger-Piktogramm im App-Quadrat.'],
  ['fahrrad', 'Fahrrad', 'Radweg frei: Fahrrad auf blauem Rund.'],
  ['knoellchen', 'Knöllchen', 'Gelber Zettel mit Abriss, wie unterm Scheibenwischer.'],
  ['paragraph', 'Paragraph', '§ auf Schildblau, roter Punkt als Akzent.'],
  ['wortmarke-owia', 'Wortmarke owia', 'Geometrische Kleinbuchstaben, i-Punkt als roter Standort.'],
  ['status-ampel', 'Status-Ampel', 'Entwurf → geprüft → versendet als Ampel.'],
  ['wappen', 'Wappen', 'Schild mit Auto: Ordnung im öffentlichen Raum.'],
  ['brief-pin', 'Brief + Pin', 'Anzeige geht per Post/Mail ans Ordnungsamt.'],
  ['eingeschraenkt', 'Eingeschränktes Halteverbot', 'Nur das Schild – der Ring liest sich zugleich als „O“.'],
  ['qr-sticker', 'QR-Sticker', 'QR-Code mit Halteverbots-Ecke, Bezug zu den Stickern.'],
  ['bordstein', 'Bordstein', 'Rotes Auto mit einem Rad auf dem Gehweg.'],
  ['fotostapel', 'Fotostapel', 'Beweisfotos übereinander.'],
  ['smartphone', 'Smartphone', 'Handy mit Schild und Auslöser: melden in Sekunden.'],
  ['hexagon', 'Hexagon-Badge', 'Dunkles Sechseck, Schriftzug in Signalgelb.'],
  ['zebrastreifen', 'Zebrastreifen', 'Auto in Draufsicht mitten auf dem Überweg.'],
  ['pin-uhr', 'Pin mit Uhr', 'Wo und wann – Tatort und Tatzeit.'],
  ['warndreieck', 'Warndreieck', 'Gefahrzeichen mit Auto.'],
  ['papierflieger', 'Papierflieger', 'Abschicken: die Anzeige ist unterwegs.'],
  ['a-strasse', 'A als Straße', 'Fluchtende Straße bildet ein A, Haltelinie als Querstrich.'],
  ['parkuhr', 'Parkuhr', 'Klassische Parkuhr mit P im Fenster.'],
  ['p-durchgestrichen', 'P durchgestrichen', 'Parkplatz-P mit rotem Balken: hier nicht.'],
]

export default async function logosRoutes(app: FastifyInstance) {
  app.get('/logos', async (request, reply) => {
    const logos = ENTWUERFE.map(([slug, name, idee], i) => {
      const datei = `${String(i + 1).padStart(2, '0')}-${slug}`
      return {
        nr: i + 1,
        name,
        idee,
        hell: `/public/logos/${datei}.svg`,
        dunkel: `/public/logos/${datei}-dunkel.svg`,
      }
    })
    return reply.view('/public/logos.ejs', viewData(request, { title: 'Logo-Entwürfe', wide: true, logos }))
  })
}
