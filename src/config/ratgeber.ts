// Ratgeber-/Landingpages (SEO): Themenseiten zu typischen Suchanfragen
// („Gehweg zugeparkt", „Einfahrt zugeparkt was tun" …) und der Bußgeldkatalog.
// Gerendert von routes/ratgeber.ts mit views/ratgeber/*.ejs; robots.txt und
// sitemap.xml (routes/public.ts) lesen die Slugs aus RATGEBER_SEITEN.
//
// Inhalt bleibt ehrlich: keine erfundenen Zahlen, Beträge kommen live aus dem
// KBA-Katalog (regelsatzEuro), Rechtsangaben nur mit Fundstelle. `html` ist
// eigener, statischer Text (wird unescaped gerendert) – keine Nutzerdaten hier.

/** Inhaltlicher Stand (sichtbar + dateModified/lastmod). Bei Textänderungen mitziehen. */
export const RATGEBER_STAND = { iso: '2026-10-09', text: 'Oktober 2026' }

export interface RatgeberThema {
  /** Pfad ohne führenden Slash – zugleich das Keyword in der URL. */
  slug: string
  /** Kurzname für Links, Brotkrümel und Karten. */
  kurz: string
  icon: string
  h1: string
  pageTitle: string
  metaDescription: string
  /** Lead unter der H1 (HTML). */
  lead: string
  /** Inhaltsabschnitte; `id` = Sprungmarke im Inhaltsverzeichnis. */
  abschnitte: { id: string; h2: string; html: string }[]
  /** Bußgeld-Tabelle: TBNR in Anzeigereihenfolge (Text + Betrag aus dem Katalog). */
  tbnr: string[]
  /** FAQ (Klartext – geht 1:1 ins FAQPage-Schema). */
  faq: [string, string][]
}

const SOFORT_ANRUFEN = `
  <p>Behindert oder gefährdet das Fahrzeug gerade jemanden, ist ein Anruf der schnellste Weg:
  beim <strong>Ordnungsamt</strong> (Verkehrsüberwachung, Stadtpolizei) deiner Stadt oder – außerhalb
  der Dienstzeiten – bei der <strong>Polizei</strong> über die örtliche Wache. Den Notruf 110 wählst du nur bei
  unmittelbarer Gefahr. Nur die Behörde darf ein Fahrzeug im öffentlichen Straßenraum abschleppen lassen.</p>`

const NACHTRAEGLICH = `
  <p>Ist es nicht dringend, erstattest du im Nachhinein eine <strong>Privatanzeige</strong> beim Ordnungsamt.
  Dafür brauchst du Fotos, Ort, Datum, Uhrzeit und das Kennzeichen. Mit dem OWiA-Anzeiger lädst du die
  Fotos hoch, Tatort und Uhrzeit werden aus den Bildern übernommen, das Kennzeichen wird automatisch
  erkannt – und die Anzeige geht an das zuständige Ordnungsamt. Kostenlos.</p>`

const FOTOS = `
  <ul>
    <li><strong>Übersicht</strong>: Fahrzeug samt Umgebung, so dass Schild, Markierung oder Bordstein erkennbar sind.</li>
    <li><strong>Kennzeichen</strong>: eine Nahaufnahme, auf der es gut lesbar ist.</li>
    <li><strong>Dauer</strong>: ein zweites Foto einige Minuten später belegt, dass es kein kurzes Halten war.</li>
    <li><strong>Behinderung</strong>: kommt sichtbar niemand vorbei, gilt der höhere Regelsatz – halte das fest.</li>
    <li><strong>Datenschutz</strong>: Personen auf den Bildern lassen sich im OWiA-Anzeiger vor dem Absenden schwärzen.</li>
  </ul>
  <p class="mb-0"><strong>Nicht selbst eingreifen:</strong> kein Zettel an der Scheibe, keine Diskussion vor Ort.</p>`

export const RATGEBER_THEMEN: RatgeberThema[] = [
  {
    slug: 'gehweg-zugeparkt',
    kurz: 'Gehweg zugeparkt',
    icon: '🚶',
    h1: 'Gehweg zugeparkt – was tun?',
    pageTitle: 'Gehweg zugeparkt: Gehwegparker melden & Bußgeld 2026',
    metaDescription:
      'Auto auf dem Gehweg? Wann Gehwegparken verboten ist, welches Bußgeld droht und wie du Gehwegparker kostenlos beim Ordnungsamt meldest – mit Fotos, in 2 Minuten.',
    lead: `Autos auf dem Gehweg zwingen Kinderwagen, Rollstühle und Kinder auf die Fahrbahn. Parken auf dem
      Gehweg ist <strong>verboten, solange es kein Schild ausdrücklich erlaubt</strong> – und du darfst es melden.`,
    abschnitte: [
      {
        id: 'regel',
        h2: 'Wann ist Parken auf dem Gehweg erlaubt?',
        html: `
          <p>Fahrzeuge müssen die Fahrbahn benutzen (§ 2 Abs. 1 StVO). Auf dem Gehweg parken darf man nur, wo es
          <strong>ausdrücklich erlaubt</strong> ist – durch das Zeichen 315 („Parken auf Gehwegen") oder eine
          Parkflächen-Markierung (§ 12 Abs. 4a StVO). Auch dann gilt das nur für die angegebene Aufstellart
          und in der Regel nur für Fahrzeuge bis 2,8 t.</p>
          <p>„Halb auf dem Bordstein, weil die Straße so eng ist" ist also <strong>keine Ausnahme</strong> – auch wenn
          es vielerorts lange geduldet wurde. Das Bundesverwaltungsgericht hat 2024 entschieden, dass Anwohnende
          unter Umständen verlangen können, dass die Straßenverkehrsbehörde gegen aufgesetztes Gehwegparken
          einschreitet (Urteil vom 6. Juni 2024, Az. 3 C 5.23).</p>`,
      },
      { id: 'sofort', h2: 'Gehweg blockiert: sofort anrufen', html: SOFORT_ANRUFEN },
      {
        id: 'anzeigen',
        h2: 'Gehwegparker online anzeigen',
        html: NACHTRAEGLICH + `
          <p>Gerade beim Dauerparken vor der Haustür lohnt sich das: Jede Anzeige wird beim Ordnungsamt
          aktenkundig – und häufen sich die Meldungen an einer Stelle, wird der Brennpunkt sichtbar.</p>`,
      },
      { id: 'fotos', h2: 'Die richtigen Beweisfotos', html: FOTOS },
    ],
    tbnr: ['112454', '112655', '112656', '112657', '112658', '141184', '141785', '112484'],
    faq: [
      ['Ist Parken auf dem Gehweg erlaubt?',
       'Nur, wenn es durch Zeichen 315 oder eine Parkflächen-Markierung ausdrücklich erlaubt ist (§ 12 Abs. 4a StVO). Ohne Schild ist Parken auf dem Gehweg verboten – auch mit zwei Rädern auf dem Bordstein.'],
      ['Was kostet Parken auf dem Gehweg?',
       'Der Regelsatz laut bundesweitem Bußgeldkatalog steht in der Tabelle auf dieser Seite. Behindert oder gefährdet das Fahrzeug andere oder steht es länger als eine Stunde, steigt der Betrag.'],
      ['Darf ich Gehwegparker anzeigen?',
       'Ja. Jeder darf einen Parkverstoß beim Ordnungsamt anzeigen. Du brauchst Fotos, Ort, Zeit und Kennzeichen und wirst als Zeugin oder Zeuge mit Name und Anschrift benannt.'],
      ['Wie viel Platz muss auf dem Gehweg bleiben?',
       'Wo Gehwegparken nicht erlaubt ist, spielt die Restbreite keine Rolle – der Verstoß liegt schon im Parken auf dem Gehweg. Wo es erlaubt ist, müssen Fußgängerinnen und Fußgänger, auch mit Rollstuhl oder Kinderwagen, ungehindert vorbeikommen.'],
      ['Darf ich auf dem Gehweg kurz halten?',
       'Nein. Der Gehweg ist Fußgängerinnen und Fußgängern vorbehalten; auch kurzes Halten ist dort nicht erlaubt, solange kein Schild das Parken auf dem Gehweg zulässt.'],
    ],
  },
  {
    slug: 'radweg-zugeparkt',
    kurz: 'Radweg zugeparkt',
    icon: '🚲',
    h1: 'Radweg zugeparkt – was tun?',
    pageTitle: 'Radweg zugeparkt: Falschparker melden & Bußgeld 2026',
    metaDescription:
      'Auto auf dem Radweg oder Radfahrstreifen? Was verboten ist, welches Bußgeld droht und wie du Radweg-Parker kostenlos beim Ordnungsamt anzeigst.',
    lead: `Wer auf dem Radweg parkt, zwingt Radfahrende in den fließenden Verkehr. Auf Radwegen und
      Radfahrstreifen ist <strong>Parken verboten</strong>, auf Schutzstreifen sogar schon das Halten.`,
    abschnitte: [
      {
        id: 'regel',
        h2: 'Was gilt auf Radweg, Radfahrstreifen und Schutzstreifen?',
        html: `
          <ul>
            <li><strong>Radweg und Radfahrstreifen</strong> (blaues Zeichen 237, 240, 241 oder durchgezogene Linie
            mit Fahrrad-Symbol): Parken ist verboten. Auch auf <strong>unbeschilderten Radwegen</strong> darf nicht
            geparkt werden – der Bußgeldkatalog kennt dafür eigene Tatbestände.</li>
            <li><strong>Schutzstreifen</strong> (gestrichelte Linie, Zeichen 340): Seit der StVO-Novelle 2020 ist dort
            schon das <strong>Halten</strong> verboten.</li>
            <li><strong>Gemeinsamer Geh- und Radweg</strong> (Zeichen 240): Hier gilt doppelt, was für Gehwege gilt –
            Parken ist verboten.</li>
          </ul>`,
      },
      { id: 'sofort', h2: 'Radweg blockiert: sofort anrufen', html: SOFORT_ANRUFEN },
      { id: 'anzeigen', h2: 'Radweg-Parker online anzeigen', html: NACHTRAEGLICH },
      { id: 'fotos', h2: 'Die richtigen Beweisfotos', html: FOTOS },
    ],
    tbnr: ['141174', '141775', '112474', '112675', '112676', '112678', '141184'],
    faq: [
      ['Was kostet Parken auf dem Radweg?',
       'Den Regelsatz laut Bußgeldkatalog zeigt die Tabelle auf dieser Seite. Mit Behinderung anderer, bei Gefährdung oder wenn das Fahrzeug länger als eine Stunde steht, wird es teurer.'],
      ['Darf ich auf dem Schutzstreifen halten?',
       'Nein. Auf Schutzstreifen für den Radverkehr (gestrichelte Linie, Zeichen 340) ist seit der StVO-Novelle 2020 auch das Halten verboten.'],
      ['Wen rufe ich an, wenn der Radweg blockiert ist?',
       'Das Ordnungsamt bzw. die Verkehrsüberwachung deiner Stadt, außerhalb der Dienstzeiten die Polizei. Für Frankfurt, Wiesbaden, Mainz, Hamburg und Hanau findest du die Nummern auf den Stadtseiten des OWiA-Anzeigers.'],
      ['Kann ich Radweg-Parker auch später noch anzeigen?',
       'Ja. Eine Anzeige mit Fotos ist auch Stunden oder Tage später möglich. Parkverstöße verjähren nach drei Monaten; manche Städte nehmen online nur Verstöße der letzten Wochen an – reiche also zeitnah ein.'],
    ],
  },
  {
    slug: 'feuerwehrzufahrt-zugeparkt',
    kurz: 'Feuerwehrzufahrt zugeparkt',
    icon: '🚒',
    h1: 'Feuerwehrzufahrt zugeparkt – was tun?',
    pageTitle: 'Feuerwehrzufahrt zugeparkt: wen anrufen? Bußgeld & Abschleppen',
    metaDescription:
      'Feuerwehrzufahrt oder Rettungsweg zugeparkt? Wen du sofort anrufst, wann abgeschleppt wird, welches Bußgeld droht und wie du den Verstoß anzeigst.',
    lead: `Eine zugeparkte Feuerwehrzufahrt kann im Ernstfall Leben kosten. Hier gilt:
      <strong>nicht abwarten, sondern anrufen</strong> – das Fahrzeug wird in der Regel abgeschleppt.`,
    abschnitte: [
      {
        id: 'erkennen',
        h2: 'Woran erkenne ich eine Feuerwehrzufahrt?',
        html: `
          <ul>
            <li>Rechteckiges Schild <strong>„Feuerwehrzufahrt"</strong> (rot umrandet, nach DIN 4066) – oft mit dem Hinweis
            „von der Behörde genehmigt", dann ist sie amtlich gekennzeichnet.</li>
            <li><strong>Halteverbots-Schild</strong> (Zeichen 283) mit Zusatzzeichen „Feuerwehrzufahrt", „Rettungsweg" oder
            „Feuerwehranfahrtszone".</li>
            <li>Markierte <strong>Aufstellflächen</strong> für die Drehleiter, häufig mit rot-weißer Begrenzung.</li>
          </ul>
          <p>Auch ohne Schild gilt: Wer eine Durchfahrt so verengt, dass Lösch- und Rettungsfahrzeuge nicht mehr
          durchkommen, behindert andere und handelt ordnungswidrig.</p>`,
      },
      {
        id: 'sofort',
        h2: 'Sofort anrufen – nicht erst anzeigen',
        html: SOFORT_ANRUFEN + `
          <p>Läuft gerade ein Einsatz und die Feuerwehr kommt nicht durch, wählst du die <strong>112</strong>.
          Sag beim Anruf gleich das Stichwort <strong>„Feuerwehrzufahrt blockiert"</strong>, die genaue Adresse und das Kennzeichen.</p>`,
      },
      {
        id: 'abschleppen',
        h2: 'Wird das Auto abgeschleppt?',
        html: `
          <p>Ob abgeschleppt wird, entscheidet die Behörde vor Ort. Bei blockierten Feuerwehrzufahrten und
          Rettungswegen halten die Gerichte das Abschleppen in aller Regel für verhältnismäßig – auch ohne
          vorherigen Versuch, den Halter zu erreichen. Die Kosten trägt der Halter bzw. die Fahrerin oder der Fahrer.</p>`,
      },
      { id: 'anzeigen', h2: 'Zusätzlich anzeigen', html: NACHTRAEGLICH },
      { id: 'fotos', h2: 'Die richtigen Beweisfotos', html: FOTOS },
    ],
    tbnr: ['112216', '112612', '141056', '141518'],
    faq: [
      ['Wen rufe ich an, wenn die Feuerwehrzufahrt zugeparkt ist?',
       'Das Ordnungsamt bzw. die Verkehrspolizei deiner Stadt, außerhalb der Dienstzeiten die Polizei. Läuft gerade ein Einsatz und die Feuerwehr kommt nicht durch, wählst du die 112.'],
      ['Was kostet Parken in der Feuerwehrzufahrt?',
       'Den Regelsatz laut Bußgeldkatalog zeigt die Tabelle auf dieser Seite. Wird ein Rettungsfahrzeug im Einsatz behindert, ist der Betrag deutlich höher; dazu kommen gegebenenfalls die Abschleppkosten.'],
      ['Darf eine Feuerwehrzufahrt sofort abgeschleppt werden?',
       'In der Regel ja. Weil im Ernstfall jede Minute zählt, gilt das Abschleppen aus Feuerwehrzufahrten und Rettungswegen als verhältnismäßig. Die Entscheidung trifft die Behörde vor Ort.'],
      ['Gilt das auch für Feuerwehrzufahrten auf Privatgelände?',
       'Ja, wenn sie amtlich gekennzeichnet sind – etwa auf Supermarkt-Parkplätzen oder in Wohnanlagen. Die Kennzeichnung ist dann wie ein Verkehrszeichen zu beachten.'],
    ],
  },
  {
    slug: 'einfahrt-zugeparkt',
    kurz: 'Einfahrt zugeparkt',
    icon: '🚗',
    h1: 'Einfahrt zugeparkt – was tun?',
    pageTitle: 'Einfahrt zugeparkt: was tun? Abschleppen lassen & Bußgeld',
    metaDescription:
      'Einfahrt oder Garage zugeparkt? Wen du anrufst, ob du abschleppen lassen darfst, welches Bußgeld droht und wie du den Falschparker anzeigst.',
    lead: `Du kommst nicht aus deiner Einfahrt oder Garage? Parken vor Grundstücksein- und -ausfahrten ist
      <strong>verboten</strong> – und wer dich zuparkt, kann abgeschleppt werden.`,
    abschnitte: [
      {
        id: 'regel',
        h2: 'Was sagt die StVO?',
        html: `
          <p>Vor Grundstücksein- und -ausfahrten ist das Parken unzulässig, auf schmalen Fahrbahnen auch
          <strong>gegenüber</strong> davon (§ 12 Abs. 3 Nr. 3 StVO). Dasselbe gilt vor <strong>Bordsteinabsenkungen</strong>.
          Kurzes Halten (bis drei Minuten, oder zum Ein- und Aussteigen bzw. Be- und Entladen) ist dort erlaubt –
          danach ist es Parken.</p>`,
      },
      {
        id: 'sofort',
        h2: 'Zugeparkt: Wen rufe ich an?',
        html: `
          <p>Steht das Auto auf der <strong>öffentlichen Straße</strong> vor deiner Einfahrt, rufst du das
          <strong>Ordnungsamt</strong> bzw. außerhalb der Dienstzeiten die <strong>Polizei</strong>. Sie versuchen den
          Halter zu erreichen und lassen das Fahrzeug notfalls abschleppen. Selbst einen Abschleppdienst für
          die öffentliche Straße beauftragen solltest du nicht.</p>
          <p>Anders auf <strong>deinem eigenen Grundstück</strong>: Wer unbefugt auf deinem Privatgrund parkt, stört
          deinen Besitz. Du darfst das Fahrzeug dann abschleppen lassen und die Kosten vom Falschparker verlangen
          (Bundesgerichtshof, Urteil vom 5. Juni 2009, Az. V ZR 144/08). Fotografiere die Situation vorher.</p>`,
      },
      { id: 'anzeigen', h2: 'Falschparker vor der Einfahrt anzeigen', html: NACHTRAEGLICH },
      { id: 'fotos', h2: 'Die richtigen Beweisfotos', html: FOTOS },
    ],
    tbnr: ['112292', '112293', '112294', '112302', '112372', '112373', '101024'],
    faq: [
      ['Was tun, wenn die Einfahrt zugeparkt ist?',
       'Steht das Fahrzeug auf der öffentlichen Straße, rufst du das Ordnungsamt oder außerhalb der Dienstzeiten die Polizei. Die Behörde versucht den Halter zu erreichen und lässt notfalls abschleppen. Zusätzlich kannst du eine Anzeige mit Fotos erstatten.'],
      ['Darf ich ein Auto vor meiner Einfahrt selbst abschleppen lassen?',
       'Auf der öffentlichen Straße nicht – das entscheidet die Behörde. Auf deinem eigenen Grundstück dagegen darfst du ein unbefugt abgestelltes Fahrzeug abschleppen lassen und die Kosten verlangen (BGH, Az. V ZR 144/08).'],
      ['Was kostet Parken vor einer Einfahrt?',
       'Den Regelsatz laut Bußgeldkatalog zeigt die Tabelle auf dieser Seite. Kommst du nicht heraus oder steht das Fahrzeug länger als drei Stunden, wird es teurer.'],
      ['Darf ich vor meiner eigenen Einfahrt parken?',
       'Die StVO verbietet das Parken vor Grundstücksein- und -ausfahrten grundsätzlich. Viele Ordnungsämter dulden es beim eigenen Fahrzeug, wenn niemand behindert wird – einen Anspruch darauf gibt es aber nicht.'],
    ],
  },
  {
    slug: 'behindertenparkplatz-zugeparkt',
    kurz: 'Behindertenparkplatz belegt',
    icon: '♿',
    h1: 'Behindertenparkplatz unberechtigt belegt – was tun?',
    pageTitle: 'Behindertenparkplatz belegt: melden, Bußgeld & Abschleppen',
    metaDescription:
      'Behindertenparkplatz ohne Ausweis belegt? Wer dort parken darf, welches Bußgeld droht, wann abgeschleppt wird und wie du den Verstoß meldest.',
    lead: `Ein Behindertenparkplatz ist oft der einzige Weg für Menschen mit Rollstuhl, ins Auto oder aus dem Auto
      zu kommen. Wer ihn <strong>ohne Parkausweis</strong> belegt, handelt ordnungswidrig.`,
    abschnitte: [
      {
        id: 'regel',
        h2: 'Wer darf auf dem Behindertenparkplatz parken?',
        html: `
          <p>Sonderparkplätze sind mit Zeichen 314 oder 315 und dem <strong>Zusatzzeichen mit Rollstuhl-Symbol</strong>
          gekennzeichnet. Parken dürfen dort nur Fahrzeuge, in denen der <strong>blaue EU-Parkausweis</strong> gut lesbar
          ausliegt – für Menschen mit außergewöhnlicher Gehbehinderung, blinde Menschen und vergleichbare
          Einschränkungen. Ein Schwerbehindertenausweis allein oder der orangefarbene Parkausweis berechtigen
          dazu nicht.</p>
          <p>Auf <strong>Supermarkt- und Privatparkplätzen</strong> gilt die StVO nur, wenn der Platz öffentlich zugänglich
          und entsprechend beschildert ist; sonst greift die Parkordnung des Betreibers.</p>`,
      },
      {
        id: 'sofort',
        h2: 'Sofort melden',
        html: SOFORT_ANRUFEN + `
          <p>Unberechtigt abgestellte Fahrzeuge auf Behindertenparkplätzen dürfen in der Regel abgeschleppt
          werden – auch wenn gerade niemand den Platz braucht.</p>`,
      },
      { id: 'anzeigen', h2: 'Verstoß online anzeigen', html: NACHTRAEGLICH },
      {
        id: 'fotos',
        h2: 'Die richtigen Beweisfotos',
        html: FOTOS.replace('<li><strong>Kennzeichen</strong>',
          '<li><strong>Windschutzscheibe</strong>: ein Foto, das zeigt, dass kein Parkausweis ausliegt.</li>\n    <li><strong>Kennzeichen</strong>'),
      },
    ],
    tbnr: ['142278'],
    faq: [
      ['Was kostet unberechtigtes Parken auf dem Behindertenparkplatz?',
       'Den Regelsatz laut Bußgeldkatalog zeigt die Tabelle auf dieser Seite. Dazu kommen gegebenenfalls die Kosten fürs Abschleppen.'],
      ['Darf ich mit Schwerbehindertenausweis auf dem Behindertenparkplatz parken?',
       'Nur mit dem blauen EU-Parkausweis, der gut lesbar hinter der Windschutzscheibe liegt. Der Schwerbehindertenausweis allein oder der orangefarbene Parkausweis reichen nicht.'],
      ['Wird man auf dem Behindertenparkplatz abgeschleppt?',
       'In der Regel ja. Die Rechtsprechung hält das Abschleppen für verhältnismäßig, auch wenn der Platz gerade nicht gebraucht wird – die Entscheidung trifft die Behörde.'],
      ['Kann ich das auch auf dem Supermarkt-Parkplatz melden?',
       'Ist der Parkplatz öffentlich zugänglich und der Sonderparkplatz mit Zeichen 314/315 und Rollstuhl-Zusatzzeichen beschildert, ja. Andernfalls ist der Betreiber zuständig – sprich den Markt an.'],
    ],
  },
]

/** Kategorien des Bußgeldkatalogs (Seite /bussgeldkatalog-parken). Reihenfolge =
 *  Prüfreihenfolge: der erste passende Treffer gewinnt, Rest landet in „Sonstiges". */
export const KATALOG_KATEGORIEN: { id: string; titel: string; re: RegExp; thema?: string }[] = [
  { id: 'feuerwehr', titel: 'Feuerwehrzufahrt & Rettungsweg', re: /Feuerwehr|Rettungsweg/i, thema: 'feuerwehrzufahrt-zugeparkt' },
  { id: 'sonderparkplatz', titel: 'Behinderten-, E- und Carsharing-Parkplätze', re: /Schwerbehinderte|elektrisch|Carsharing|Bewohner/i, thema: 'behindertenparkplatz-zugeparkt' },
  { id: 'radweg', titel: 'Radweg & Radfahrstreifen', re: /Radweg|Radfahrstreifen|Fahrradstraße|Fahrradzone/i, thema: 'radweg-zugeparkt' },
  { id: 'gehweg', titel: 'Gehweg & Fußgängerzone', re: /Gehweg|Fußgängerzone|verkehrsberuhigt/i, thema: 'gehweg-zugeparkt' },
  { id: 'einfahrt', titel: 'Einfahrt & Bordsteinabsenkung', re: /Grundstücksein|Bordsteinabsenkung|nicht wegfahren/i, thema: 'einfahrt-zugeparkt' },
  { id: 'fussgaenger', titel: 'Fußgängerüberweg & Furt', re: /Fußgängerüberweg|Fußgängerfurt/i },
  { id: 'haltestelle', titel: 'Haltestelle & Busspur', re: /Haltestelle|Bussonderfahrstreifen|Taxenstand/i },
  { id: 'kreuzung', titel: 'Kreuzung, Einmündung & Kurve', re: /Kreuzung|Einmündung|Kurve|scharfen/i },
  { id: 'halteverbot', titel: 'Halteverbot (Zeichen 283/286)', re: /Haltverbot/i },
  { id: 'zweite-reihe', titel: 'Zweite Reihe & Fahrbahn', re: /zweiten Reihe|linken Fahrbahnseite|Fahrbahn/i },
  { id: 'parkschein', titel: 'Parkschein, Parkscheibe & Parkuhr', re: /Parkschein|Parkscheibe|Parkuhr|Parkscheinautomat|Höchstparkdauer/i },
]
