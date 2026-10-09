// Textvorlagen für Sticker (gesetzt von services/stickerSatz.ts). Zu sehen
// unter /sticker-test (mit Favoriten), wählbar beim Erzeugen unter /sticker.
//
// Die Nummer einer Vorlage ist ihre Position hier; Batches und Favoriten
// speichern den Slug. Neue Vorlagen nur hinten anfügen, Slugs nie umbenennen
// oder löschen (alte Batches müssen sich weiter drucken lassen).
//
// Texte: **fett**, ==gelb markiert==, __unterstrichen__, {betrag} = Regelsatz
// des Batch-Tatbestands (bzw. des festen `tbnr` der Vorlage). Nur Zeichen, die
// die PDF-Standardschriften kennen (WinAnsi: „“ ’ – … · € é ä ö ü ß).
import { Entwurf, brauchtBetrag } from './stickerSatz'

const GEHWEG = '112454'
const F = {
  notiz: 'Bitte werfen Sie diese Notiz nicht auf den Boden.',
  zettel: 'Bitte werfen Sie diesen Zettel nicht auf den Boden.',
  blatt: 'Bitte werfen Sie dieses Blatt nicht auf den Boden.',
  danke: 'Bitte nicht auf den Boden werfen. Danke!',
  papier: 'Bitte nicht auf den Boden werfen – Altpapier ist um die Ecke.',
}

export const ENTWUERFE: Entwurf[] = [
  {
    slug: 'sachlich-ordnungsamt', name: 'Sachlich – Ordnungsamt', idee: 'Ihr Wortlaut, ruhig gesetzt. Betrag als einzige Farbfläche.',
    bloecke: [
      { t: 'bar' },
      { t: 'h', text: 'Sie wurden von einer Privatperson beim Ordnungsamt angezeigt.' },
      { t: 'p', text: 'Sollte das Ordnungsamt diese Anzeige verfolgen, kostet Sie das wahrscheinlich =={betrag}==.' },
      { t: 's', text: 'Fotos und Details zur Anzeige: QR-Code scannen.' },
    ],
    fein: F.notiz,
  },
  {
    slug: 'sachlich-polizei', name: 'Sachlich – Verkehrspolizei', idee: 'Ihr erster Wortlaut. Nur für Städte, in denen die Polizei den ruhenden Verkehr verfolgt.',
    rahmen: { band: 'Hinweis zu Ihrem Fahrzeug' },
    bloecke: [
      { t: 'h', text: 'Eine Privatperson hat Sie im ruhenden Verkehr bei der Verkehrspolizei angezeigt.' },
      { t: 'p', text: 'Verfolgt die Polizei die Anzeige, kostet Sie das wahrscheinlich **{betrag}**.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'preis-zuerst', name: 'Der Preis zuerst', idee: 'Der Betrag ist das, was auf zwei Meter Abstand gelesen wird.',
    bloecke: [
      { t: 'preis' },
      { t: 'h', text: 'So viel kostet Sie dieser Parkplatz wahrscheinlich.' },
      { t: 's', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Ob ein Verwarnungsgeld fällig wird, entscheidet das Amt.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'stempel', name: 'Stempel', idee: 'Ein Wort, schräg gestempelt. Tatbestand und Regelsatz klein darunter.', tbnr: GEHWEG,
    bloecke: [
      { t: 'stempel', text: 'Angezeigt' },
      { t: 'p', text: 'von einer Privatperson beim Ordnungsamt.' },
      { t: 's', text: 'Parken auf dem Gehweg · Regelsatz {betrag}' },
    ],
    fein: F.danke,
  },
  {
    slug: 'warnband', name: 'Warnband', idee: 'Absperrband-Rahmen: fällt auf der Scheibe sofort auf.',
    rahmen: 'warnband',
    bloecke: [
      { t: 'h', text: 'Achtung: Dieses Fahrzeug wurde angezeigt.' },
      { t: 'p', text: 'Eine Privatperson hat Fotos an das Ordnungsamt geschickt. Wahrscheinliche Kosten: **{betrag}**.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'beleg', name: 'Beleg', idee: 'Wie ein Kassenbon – und ausdrücklich keine amtliche Mitteilung.', tbnr: GEHWEG,
    schrift: 'mono',
    bloecke: [
      {
        t: 'zeilen', kopf: 'Anzeige-Beleg', items: [
          ['Erstattet von', 'Privatperson'],
          ['Empfänger', 'Ordnungsamt'],
          ['Tatbestand', 'Parken auf Gehweg'],
          ['Regelsatz', '{betrag}'],
          ['Status', 'übermittelt'],
        ],
      },
    ],
    fein: 'Keine amtliche Mitteilung. Bitte nicht auf den Boden werfen.',
  },
  {
    slug: 'vorwarnung', name: 'Freundliche Vorwarnung', idee: 'Gleicher Inhalt, aber als Info „bevor Post kommt“ – nimmt Ärger raus.',
    bloecke: [
      { t: 'kicker', text: 'Kurze Info, bevor Post kommt' },
      { t: 'h', text: 'Ihr Fahrzeug wurde von einer Privatperson beim Ordnungsamt angezeigt.' },
      { t: 'p', text: 'Verfolgt das Amt die Anzeige, kostet Sie das wahrscheinlich =={betrag}==.' },
    ],
    fein: F.notiz,
  },
  {
    slug: 'kinderwagen', name: 'Gehweg – Kinderwagen', idee: 'Begründet die Anzeige mit den Betroffenen statt mit der Regel.', tbnr: GEHWEG,
    bloecke: [
      { t: 'bar' },
      { t: 'h', text: 'Hier wollte jemand mit Kinderwagen vorbei.' },
      { t: 'p', text: '… und hat Sie deshalb beim Ordnungsamt angezeigt. Parken auf dem Gehweg kostet wahrscheinlich =={betrag}==.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'radweg', name: 'Radweg', idee: 'Dunkler Sticker, eine klare Aussage in Gelb.', tbnr: '112474',
    grund: 'dunkel',
    bloecke: [
      { t: 'h', text: 'Dieser Radweg ist kein Parkplatz.', gelb: true },
      { t: 'p', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Wahrscheinliche Kosten: **{betrag}**.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'feuerwehr', name: 'Feuerwehrzufahrt', idee: 'Kopfband nennt den Ort, die Zeile darunter das Warum.', tbnr: '112216',
    rahmen: { band: 'Feuerwehrzufahrt' },
    bloecke: [
      { t: 'h', text: 'Im Ernstfall zählt jede Sekunde.' },
      { t: 'p', text: 'Eine Privatperson hat Ihr Fahrzeug beim Ordnungsamt angezeigt. Parken in der Feuerwehrzufahrt kostet wahrscheinlich **{betrag}**.' },
    ],
    fein: F.danke,
  },
  {
    slug: 'checkliste', name: 'Checkliste', idee: 'Zwei Haken gesetzt, der dritte liegt beim Amt.',
    bloecke: [
      {
        t: 'liste', art: 'haken', items: [
          { text: 'Falschparken fotografiert', an: true },
          { text: 'Beim Ordnungsamt angezeigt', an: true },
          { text: 'Verwarnungsgeld: wahrscheinlich **{betrag}**' },
        ],
      },
      { t: 's', text: 'Den letzten Haken setzt das Ordnungsamt. Angezeigt hat Sie eine Privatperson.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'ablauf', name: 'Ablauf in 3 Schritten', idee: 'Erklärt nüchtern, was als Nächstes passiert.',
    bloecke: [
      { t: 'kicker', text: 'Was jetzt passiert' },
      {
        t: 'liste', art: 'num', items: [
          { marke: '1', text: 'Eine Privatperson hat Ihr Fahrzeug fotografiert.' },
          { marke: '2', text: 'Die Anzeige geht an das Ordnungsamt.' },
          { marke: '3', text: 'Sie bekommen Post – wahrscheinlich **{betrag}**.' },
        ],
      },
    ],
    fein: F.notiz,
  },
  {
    slug: 'zweisprachig', name: 'Zweisprachig DE/EN', idee: 'Für Touristen, Mietwagen, Lieferfahrer: beide Sprachen gleich groß.',
    bloecke: [
      {
        t: 'spalten', items: [
          { h: 'Angezeigt.', s: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Wahrscheinliche Kosten: **{betrag}**.' },
          { h: 'Reported.', s: 'A private person has reported you to the local authority. Likely fine: **{betrag}**.' },
        ],
      },
    ],
    fein: 'Bitte nicht auf den Boden werfen · Please don’t litter.',
  },
  {
    slug: 'minimal', name: 'Minimal', idee: 'Kürzeste Fassung, ohne Betrag – trägt auch auf 70 × 37 mm.',
    bloecke: [
      { t: 'riesig', text: 'Angezeigt.' },
      { t: 'p', text: 'Von einer Privatperson, beim Ordnungsamt.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'kein-knoellchen', name: 'Kein Knöllchen', idee: 'Stellt klar, dass der Zettel nicht vom Amt ist – schützt vor dem Vorwurf, ein Knöllchen vorzutäuschen.',
    bloecke: [
      { t: 'h', text: 'Das ist kein Knöllchen.' },
      { t: 'p', text: 'Sondern der Hinweis, dass eine Privatperson Sie beim Ordnungsamt angezeigt hat. Ob Sie zahlen müssen (wahrscheinlich **{betrag}**), erfahren Sie per Post.' },
    ],
    fein: F.blatt,
  },
  {
    slug: 'wussten-sie', name: 'Wussten Sie …?', idee: 'Frage als Einstieg, Antwort gleich hinterher.', tbnr: GEHWEG,
    bloecke: [
      { t: 'h', text: 'Wussten Sie, dass Parken auf dem Gehweg =={betrag}== kostet?' },
      { t: 'p', text: 'Jetzt schon: Eine Privatperson hat Sie beim Ordnungsamt angezeigt.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'teurer-parkplatz', name: 'Teurer Parkplatz', idee: 'Vollflächig gelb, zwei Wörter Schlagzeile.',
    grund: 'gelb',
    bloecke: [
      { t: 'riesig', text: 'Teurer Parkplatz.' },
      { t: 'p', text: 'Voraussichtlich **{betrag}**: Eine Privatperson hat Sie beim Ordnungsamt angezeigt.' },
    ],
    fein: F.papier,
  },
  {
    slug: 'naechstes-mal', name: 'Nächstes Mal', idee: 'Blick nach vorn statt Vorwurf.',
    bloecke: [
      { t: 'bar' },
      { t: 'h', text: 'Nächstes Mal vielleicht ein paar Meter weiter?' },
      { t: 'p', text: 'Diesmal hat eine Privatperson Sie beim Ordnungsamt angezeigt. Das kostet Sie wahrscheinlich =={betrag}==.' },
    ],
    fein: F.notiz,
  },
  {
    slug: 'datenschutz', name: 'Datenschutz-Hinweis', idee: 'Beantwortet die erste Sorge beim Scannen: Steht mein Kennzeichen im Netz?',
    bloecke: [
      { t: 'h', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt.' },
      { t: 'p', text: 'Wahrscheinliche Kosten: =={betrag}==.' },
      { t: 's', text: 'Online zeigen wir nur Verstoß, Tag und ein stark verpixeltes Foto – kein Kennzeichen.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'qr-mitte', name: 'QR im Mittelpunkt', idee: 'Großer Code links: lädt zum Scannen ein, Text erklärt warum.',
    qr: 'gross',
    bloecke: [
      { t: 'h', text: 'Was wurde hier angezeigt?' },
      { t: 'p', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Verstoß und Foto: Code scannen.' },
      { t: 's', text: 'Wahrscheinliche Kosten: **{betrag}**' },
    ],
    fein: F.zettel,
  },
  // 21–50
  {
    slug: 'dokumentiert', name: 'Fahrzeug dokumentiert', idee: 'Passt zum heutigen Ablauf: Der Sticker klebt oft, bevor die Anzeige abgeschickt ist.',
    bloecke: [
      { t: 'kicker', text: 'Hinweis' },
      { t: 'h', text: 'Ihr Fahrzeug wurde dokumentiert.' },
      { t: 'p', text: 'Eine Privatperson hat Fotos gemacht und zeigt den Verstoß beim Ordnungsamt an. Wahrscheinliche Kosten: =={betrag}==.' },
      { t: 's', text: 'Stand der Anzeige: QR-Code scannen.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'wird-angezeigt', name: 'Wird angezeigt', idee: 'Zukunftsform – ehrlich, solange die Anzeige noch nicht raus ist.',
    bloecke: [
      { t: 'bar' },
      { t: 'h', text: 'Dieses Falschparken wird angezeigt.' },
      { t: 'p', text: 'Eine Privatperson schickt Fotos an das Ordnungsamt. Verfolgt das Amt die Anzeige, kostet Sie das wahrscheinlich =={betrag}==.' },
    ],
    fein: F.notiz,
  },
  {
    slug: 'zustaendige-behoerde', name: 'Zuständige Behörde', idee: 'Ein Text für alle Städte: kein Ordnungsamt/Polizei-Unterschied.',
    bloecke: [
      { t: 'bar' },
      { t: 'h', text: 'Sie wurden von einer Privatperson bei der zuständigen Behörde angezeigt.' },
      { t: 'p', text: 'Wird die Anzeige verfolgt, kostet Sie das wahrscheinlich =={betrag}==.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'schwarzweiss', name: 'Schwarzweiß-Druck', idee: 'Ohne Gelb – sieht auch aus dem Laserdrucker sauber aus.',
    bloecke: [
      { t: 'h', text: 'Sie wurden von einer Privatperson beim Ordnungsamt angezeigt.' },
      { t: 'p', text: 'Sollte das Ordnungsamt diese Anzeige verfolgen, kostet Sie das wahrscheinlich **__{betrag}__**.' },
      { t: 's', text: 'Fotos und Details zur Anzeige: QR-Code scannen.' },
    ],
    fein: F.notiz,
  },
  {
    slug: 'halteverbot', name: 'Absolutes Haltverbot', idee: 'Erklärt das Schild gleich mit.', tbnr: '141312',
    rahmen: { band: 'Absolutes Haltverbot' },
    bloecke: [
      { t: 'h', text: 'Hier ist nicht einmal Halten erlaubt.' },
      { t: 'p', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Parken im absoluten Haltverbot kostet wahrscheinlich **{betrag}**.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'schwerbehinderte', name: 'Schwerbehindertenparkplatz', idee: 'Ruhig im Ton, deutlich in der Sache.', tbnr: '142278',
    bloecke: [
      { t: 'h', text: 'Dieser Platz gehört Menschen, die ihn wirklich brauchen.' },
      { t: 'p', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Parken auf einem Schwerbehindertenparkplatz kostet wahrscheinlich =={betrag}==.' },
    ],
    fein: F.notiz,
  },
  {
    slug: 'haltestelle', name: 'Bushaltestelle', idee: 'Kurz, mit einem Augenzwinkern.', tbnr: '141402',
    bloecke: [
      { t: 'gross', text: 'Hier hält der Bus. Eigentlich.' },
      { t: 'p', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Parken an der Haltestelle kostet wahrscheinlich **{betrag}**.' },
    ],
    fein: F.danke,
  },
  {
    slug: 'zebrastreifen', name: 'Zebrastreifen', idee: 'Sichtachse für Kinder als Begründung.', tbnr: '141302',
    bloecke: [
      { t: 'h', text: 'Kinder sehen nicht über Autos hinweg.' },
      { t: 'p', text: 'Deshalb gilt 5 Meter vor dem Zebrastreifen Parkverbot. Eine Privatperson hat Sie beim Ordnungsamt angezeigt – wahrscheinlich =={betrag}==.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'kreuzung', name: '5 Meter vor der Kreuzung', idee: 'Kleiner Betrag, großer Grund – ehrlich mit 10 €.', tbnr: '112262',
    bloecke: [
      { t: 'h', text: '5 Meter Abstand zur Kreuzung.' },
      { t: 'p', text: 'Damit alle sehen und gesehen werden. Eine Privatperson hat Sie beim Ordnungsamt angezeigt.' },
      { t: 's', text: 'Kosten: wahrscheinlich **{betrag}** – der Grund ist größer.' },
    ],
    fein: F.notiz,
  },
  {
    slug: 'rollstuhl', name: 'Rollstuhl', idee: 'Wer hier nicht durchkommt, mit Piktogramm.', tbnr: GEHWEG,
    links: 'rollstuhl', qr: 'klein',
    bloecke: [
      { t: 'h', text: 'Mit dem Rollstuhl kommt hier niemand vorbei.' },
      { t: 'p', text: 'Deshalb hat eine Privatperson Sie beim Ordnungsamt angezeigt. Wahrscheinlich **{betrag}**.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'schulweg', name: 'Schulweg', idee: 'Für Gehwege an Schulen und Kitas.', tbnr: GEHWEG,
    rahmen: { band: 'Schulweg' },
    bloecke: [
      { t: 'h', text: 'Hier laufen jeden Morgen Kinder entlang.' },
      { t: 'p', text: 'Zugeparkte Gehwege zwingen sie auf die Fahrbahn. Eine Privatperson hat Sie beim Ordnungsamt angezeigt – wahrscheinlich **{betrag}**.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'fussgaenger-icon', name: 'Fußgänger-Piktogramm', idee: 'Großes Piktogramm links, Text rechts, QR klein.', tbnr: GEHWEG,
    links: 'fussgaenger', qr: 'klein',
    bloecke: [
      { t: 'gross', text: 'Gehweg.' },
      { t: 'p', text: 'Für Menschen zu Fuß. Eine Privatperson hat Sie beim Ordnungsamt angezeigt: wahrscheinlich **{betrag}**.' },
    ],
    fein: F.danke,
  },
  {
    slug: 'fahrrad-icon', name: 'Fahrrad-Piktogramm', idee: 'Wie 32, für Radwege.', tbnr: '112474',
    links: 'fahrrad', qr: 'klein',
    bloecke: [
      { t: 'gross', text: 'Radweg.' },
      { t: 'p', text: 'Für Menschen auf dem Rad. Eine Privatperson hat Sie beim Ordnungsamt angezeigt: wahrscheinlich **{betrag}**.' },
    ],
    fein: F.danke,
  },
  {
    slug: 'ausrufezeichen', name: 'Ausrufezeichen', idee: 'Gelber Block mit „!“ – Warnschild-Logik.',
    links: 'ausruf', qr: 'klein',
    bloecke: [
      { t: 'h', text: 'Sie wurden angezeigt.' },
      { t: 'p', text: 'Eine Privatperson hat Fotos Ihres Fahrzeugs an das Ordnungsamt geschickt. Wahrscheinliche Kosten: **{betrag}**.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'brief', name: 'Brief', idee: 'Höfliche Anrede und Gruß – wie eine kurze Nachricht.',
    bloecke: [
      { t: 'p', text: '**Guten Tag,**' },
      { t: 'p', text: 'eine Privatperson hat Ihr Fahrzeug hier beim Ordnungsamt angezeigt. Verfolgt das Amt die Anzeige, kostet Sie das wahrscheinlich {betrag}.' },
      { t: 'p', text: 'Mit freundlichen Grüßen' },
    ],
    fein: F.blatt,
  },
  {
    slug: 'nicht-persoenlich', name: 'Nicht persönlich gemeint', idee: 'Nimmt die Kränkung raus, ohne die Anzeige zu relativieren.', tbnr: GEHWEG,
    bloecke: [
      { t: 'bar' },
      { t: 'h', text: 'Nicht persönlich gemeint.' },
      { t: 'p', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt – weil der Gehweg für alle da ist. Wahrscheinliche Kosten: =={betrag}==.' },
    ],
    fein: F.notiz,
  },
  {
    slug: 'wer-wo-wie', name: 'Wer? Wo? Wie teuer?', idee: 'Drei Fragen, drei kurze Antworten.',
    bloecke: [
      {
        t: 'qa', items: [
          ['Wer hat angezeigt?', 'Eine Privatperson.'],
          ['Bei wem?', 'Beim Ordnungsamt.'],
          ['Was kostet das?', 'Wahrscheinlich =={betrag}==.'],
        ],
      },
      { t: 's', text: 'Fotos und Details: QR-Code scannen.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'rechnung', name: 'Kleine Rechnung', idee: 'Parkhaus gegen Gehweg – ohne erfundene Parkhauspreise.', tbnr: GEHWEG,
    bloecke: [
      { t: 'kicker', text: 'Kleine Rechnung' },
      { t: 'zeilen', gross: true, items: [['Parkhaus', 'ein paar Euro'], ['Gehweg', '=={betrag}==']] },
      { t: 's', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Ob Sie zahlen, entscheidet das Amt.' },
    ],
    fein: F.papier,
  },
  {
    slug: 'drei-akte', name: 'Drei Akte', idee: 'Sie · eine Privatperson · das Amt – je eine Zeile.',
    bloecke: [
      {
        t: 'liste', art: 'num', items: [
          { marke: 'I', text: 'Sie haben hier geparkt.' },
          { marke: 'II', text: 'Eine Privatperson hat es fotografiert und angezeigt.' },
          { marke: 'III', text: 'Das Ordnungsamt entscheidet – wahrscheinlich **{betrag}**.' },
        ],
      },
    ],
    fein: F.notiz,
  },
  {
    slug: 'paragraf', name: 'Paragraf', idee: 'Großes § mit Fundstelle – für Sachliche.', tbnr: GEHWEG,
    links: 'paragraf', qr: 'klein',
    bloecke: [
      { t: 'h', text: '§ 12 StVO – Halten und Parken.' },
      { t: 'p', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Regelsatz für Parken auf dem Gehweg: **{betrag}**.' },
    ],
    fein: F.blatt,
  },
  {
    slug: 'ampel', name: 'Ampel', idee: 'Zwei Punkte grün, einer offen.',
    bloecke: [
      { t: 'kicker', text: 'Stand Ihrer Anzeige' },
      {
        t: 'liste', art: 'ampel', items: [
          { text: 'Fotos gemacht', an: true },
          { text: 'Beim Ordnungsamt angezeigt', an: true },
          { text: 'Bescheid vom Amt – wahrscheinlich **{betrag}**' },
        ],
      },
      { t: 's', text: 'Angezeigt hat Sie eine Privatperson.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'sprechblase', name: 'Sprechblase', idee: '„Nur kurz“ – und die Antwort darauf.',
    bloecke: [
      { t: 'blase', text: '„Ich steh hier nur kurz.“' },
      { t: 'h', text: 'Kurz reicht für eine Anzeige.' },
      { t: 'p', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Wahrscheinliche Kosten: =={betrag}==.' },
    ],
    fein: F.danke,
  },
  {
    slug: 'kurz-geparkt', name: 'Kurz geparkt', idee: 'Vier Wörter Schlagzeile, Rest klein.',
    bloecke: [
      { t: 'gross', text: 'Kurz geparkt. Teuer geworden.' },
      { t: 'p', text: 'Wahrscheinlich =={betrag}==: Eine Privatperson hat Sie beim Ordnungsamt angezeigt.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'preis-dunkel', name: 'Preis dunkel', idee: 'Wie 3, invertiert: gelber Betrag auf Schwarz.',
    grund: 'dunkel',
    bloecke: [
      { t: 'preis' },
      { t: 'h', text: 'So viel kostet Sie dieser Parkplatz wahrscheinlich.' },
      { t: 's', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt. Ob ein Verwarnungsgeld fällig wird, entscheidet das Amt.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'abriss', name: 'Abriss-Ticket', idee: 'Ticket-Optik: kräftiges Kopfband, Code rechts.',
    rahmen: { band: 'Anzeige · Privatperson' },
    bloecke: [
      { t: 'h', text: 'Eine Privatperson hat Sie beim Ordnungsamt angezeigt.' },
      { t: 'p', text: 'Wahrscheinliche Kosten: =={betrag}==.' },
      { t: 's', text: 'Rechts: Ihr Code zur Anzeige.' },
    ],
    fein: F.notiz,
  },
  {
    slug: 'einzeiler', name: 'Einzeiler', idee: '„Angezeigt · 55 €“ – für sehr kleine Etiketten.',
    bloecke: [
      { t: 'einzeiler', text: 'Angezeigt · {betrag}' },
      { t: 'p', text: 'Von einer Privatperson beim Ordnungsamt.' },
    ],
    fein: F.zettel,
  },
  {
    slug: 'dreisprachig', name: 'Dreisprachig DE/EN/FR', idee: 'Für Grenzregionen und Touristenviertel.',
    qr: 'klein',
    bloecke: [
      {
        t: 'spalten', items: [
          { h: 'Angezeigt.', s: 'Von einer Privatperson beim Ordnungsamt. Wahrscheinlich **{betrag}**.' },
          { h: 'Reported.', s: 'By a private person to the local authority. Likely fine: **{betrag}**.' },
          { h: 'Signalé.', s: 'Par un particulier auprès des autorités. Amende probable : **{betrag}**.' },
        ],
      },
    ],
    fein: 'Bitte nicht auf den Boden werfen · Please don’t litter · Merci de ne pas jeter.',
  },
  {
    slug: 'gehweg-fuer-alle', name: 'Gehweg für alle', idee: 'Positive Botschaft vorn, Anzeige danach.', tbnr: GEHWEG,
    bloecke: [
      { t: 'h', text: 'Gehwege sind für alle da.' },
      { t: 'p', text: 'Für Kinderwagen, Rollstühle, Rollatoren und Kinder. Deshalb hat eine Privatperson Sie beim Ordnungsamt angezeigt – wahrscheinlich =={betrag}==.' },
    ],
    fein: F.danke,
  },
  {
    slug: 'zeitung', name: 'Schlagzeile', idee: 'Zeitungs-Optik mit Serifenschrift.', tbnr: GEHWEG,
    schrift: 'serif',
    bloecke: [
      { t: 'kicker', text: 'Lokales', linien: true },
      { t: 'h', text: 'Fahrzeug auf Gehweg angezeigt' },
      { t: 'p', text: 'Eine Privatperson hat das Fahrzeug beim Ordnungsamt gemeldet. Nach Bußgeldkatalog sind wahrscheinlich {betrag} fällig.' },
    ],
    fein: F.blatt,
  },
  {
    slug: 'ruhig-grau', name: 'Leise', idee: 'Kein Gelb, kein Fett – für alle, die es dezent mögen.',
    grund: 'leise',
    bloecke: [
      { t: 'p', text: 'Hinweis: Eine Privatperson hat Ihr Fahrzeug beim Ordnungsamt angezeigt.' },
      { t: 'p', text: 'Sollte das Amt die Anzeige verfolgen, kostet Sie das wahrscheinlich {betrag}.' },
    ],
    fein: F.notiz,
  },
]

const NACH_SLUG = new Map(ENTWUERFE.map((e, i) => [e.slug, { e, nr: i + 1 }]))

export function entwurf(slug: string | null | undefined): Entwurf | null {
  return (slug && NACH_SLUG.get(slug)?.e) || null
}

export function entwurfNr(slug: string): number {
  return NACH_SLUG.get(slug)?.nr ?? 0
}

/** Tatbestand für {betrag}: fester der Vorlage, sonst der gewählte. */
export function entwurfTbnr(e: Entwurf, gewaehlt: string | null | undefined): string | null {
  return e.tbnr || gewaehlt || null
}

export { brauchtBetrag }
