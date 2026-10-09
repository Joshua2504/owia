// Stadt-Landingpages „Falschparker melden in <Stadt>" (SEO). Frankfurt hat eine
// eigene, ausführlichere Seite (routes/legal.ts, LANDING_FFM); alle anderen
// rendert routes/ratgeber.ts aus diesen Daten mit views/ratgeber/stadt.ejs.
// Reihenfolge = Reihenfolge in Übersichten/Links. `id` = Schlüssel in config/cities.ts.
//
// Kontaktdaten nur aus den offiziellen Seiten der Städte/Polizei (Quellen je
// Eintrag, recherchiert 09.10.2026). Unbestätigtes (z.B. „rund um die Uhr" ohne
// Beleg) bewusst weggelassen. Bei Änderungen RATGEBER_STAND (config/ratgeber.ts) mitziehen.

export interface StadtKontakt {
  titel: string
  text: string
  /** [Anzeige, tel:-Ziel] */
  nummern: [string, string][]
  zeilen?: string[]
}

export interface StadtSeite {
  id: string
  slug: string
  name: string
  /** Kurzform für Linktexte („Frankfurt" statt „Frankfurt am Main"). */
  kurz?: string
  bundesland: string
  /** Zuständig für Anzeigen (Klartext). */
  behoerde: string
  kontakte: StadtKontakt[]
  /** Hauptnummer für den Anruf-Knopf oben: [Anzeige, tel:-Ziel, Untertitel]. */
  anruf: [string, string, string]
  /** Wie die Anzeige über den OWiA-Anzeiger ankommt (HTML, eigener Text). */
  versand: string
  stadtteile: string[]
  faq: [string, string][]
  quellen: [string, string][]
}

const ffm: StadtSeite = {
  id: 'frankfurt',
  slug: 'falschparker-melden-frankfurt',
  name: 'Frankfurt am Main',
  kurz: 'Frankfurt',
  bundesland: 'Hessen',
  behoerde: 'Ordnungsamt der Stadt Frankfurt am Main',
  // Frankfurt rendert legal.ts mit eigener View – Felder unten nur für Übersichten.
  kontakte: [],
  anruf: ['069 212-36360', 'tel:+496921236360', 'Verkehrspolizei'],
  versand: '',
  stadtteile: [],
  faq: [],
  quellen: [],
}

export const STADT_SEITEN: StadtSeite[] = [
  ffm,
  {
    id: 'wiesbaden',
    slug: 'falschparker-melden-wiesbaden',
    name: 'Wiesbaden',
    bundesland: 'Hessen',
    behoerde: 'Amt für Stadtpolizei und Ordnung der Landeshauptstadt Wiesbaden (Verwarngeldstelle)',
    anruf: ['0611 314444', 'tel:+49611314444', 'Leitstelle der Stadtpolizei'],
    kontakte: [
      {
        titel: 'Leitstelle der Stadtpolizei Wiesbaden',
        text: 'Für dringende Fälle: zugeparkte Feuerwehrzufahrt, blockierter Gehweg oder Radweg, zugestellte Einfahrt.',
        nummern: [['0611 314444', 'tel:+49611314444']],
      },
      {
        titel: 'Ordnungswidrigkeiten im Straßenverkehr',
        text: 'Fragen zu Anzeigen und Verfahren (nicht für akute Fälle).',
        nummern: [['0611 313135', 'tel:+49611313135']],
        zeilen: ['Di und Mi 9–12 Uhr', 'Gustav-Stresemann-Ring 15, 65189 Wiesbaden'],
      },
      {
        titel: 'Polizei Wiesbaden',
        text: 'Polizeipräsidium Westhessen – wenn die Stadtpolizei nicht erreichbar ist. Bei unmittelbarer Gefahr 110.',
        nummern: [['0611 345-0', 'tel:+496113450'], ['110', 'tel:110']],
      },
    ],
    versand: `<p>Seit dem 1. Oktober 2026 nimmt Wiesbaden Privatanzeigen über ein neues
      <strong>Online-Verfahren</strong> entgegen. Der OWiA-Anzeiger füllt dieses Formular für dich aus: Fotos, Tatort,
      Uhrzeit und Verstoß übernimmt er aus deinem Entwurf, die Anzeige geht an die Verwarngeldstelle. Du bekommst
      eine Bestätigung mit allen übermittelten Angaben.</p>
      <p>Das Formular nimmt nur Verstöße der <strong>letzten zwei Monate</strong> an – reiche also zeitnah ein.
      Amöneburg, Kastel und Kostheim (AKK) gehören zu Wiesbaden und werden automatisch richtig zugeordnet.</p>`,
    stadtteile: ['Mitte', 'Westend', 'Nordost', 'Südost', 'Rheingauviertel', 'Biebrich', 'Schierstein', 'Dotzheim',
      'Bierstadt', 'Sonnenberg', 'Erbenheim', 'Nordenstadt', 'Delkenheim', 'Kastel', 'Kostheim', 'Amöneburg'],
    faq: [
      ['Wen rufe ich in Wiesbaden bei Falschparkern an?',
       'Für dringende Fälle die Leitstelle der Stadtpolizei Wiesbaden unter 0611 314444. Ist dort niemand erreichbar, hilft die Polizei unter 0611 345-0; bei unmittelbarer Gefahr wählst du 110.'],
      ['Kann ich Falschparker in Wiesbaden online anzeigen?',
       'Ja. Seit Oktober 2026 nimmt Wiesbaden Privatanzeigen über ein Online-Verfahren an. Mit dem OWiA-Anzeiger lädst du Fotos hoch und die Anzeige wird über dieses Formular an die Verwarngeldstelle übermittelt.'],
      ['Wie lange kann ich einen Parkverstoß in Wiesbaden anzeigen?',
       'Das Online-Formular nimmt Verstöße der letzten zwei Monate an. Parkverstöße verjähren nach drei Monaten.'],
      ['Gehören Kastel und Kostheim zu Wiesbaden oder Mainz?',
       'Mainz-Kastel, Mainz-Kostheim und Mainz-Amöneburg gehören zur Stadt Wiesbaden. Anzeigen gehen daher an die Wiesbadener Verwarngeldstelle – der OWiA-Anzeiger ordnet das automatisch zu.'],
      ['Bleibe ich anonym?',
       'Gegenüber der Stadt nicht: Anonyme Anzeigen werden nicht bearbeitet, du wirst als Zeugin oder Zeuge benannt. Auf den öffentlichen Seiten des OWiA-Anzeigers erscheinen keine personenbezogenen Daten.'],
    ],
    quellen: [
      ['wiesbaden.de: Ordnungswidrigkeiten im Straßenverkehr', 'https://www.wiesbaden.de/vv/produkte/31/Ordnungswidrigkeiten-im-Strassenverkehr'],
      ['wiesbaden.de: Neuer Online-Dienst (Pressemitteilung)', 'https://www.wiesbaden.de/en/pressemitteilungen/pressereferat/oktober/neuer-online-dienst-fuer-das-anzeigen-von-verkehrsordnungswidrigkeiten'],
    ],
  },
  {
    id: 'mainz',
    slug: 'falschparker-melden-mainz',
    name: 'Mainz',
    bundesland: 'Rheinland-Pfalz',
    behoerde: 'Verkehrsüberwachungsamt der Landeshauptstadt Mainz',
    anruf: ['06131 12-2181', 'tel:+496131122181', 'Verkehrsüberwachungsamt'],
    kontakte: [
      {
        titel: 'Verkehrsüberwachungsamt Mainz',
        text: 'Überwacht den ruhenden Verkehr und veranlasst Abschleppmaßnahmen.',
        nummern: [['06131 12-2181', 'tel:+496131122181'], ['06131 12-3086', 'tel:+496131123086']],
        zeilen: ['Mo–Do 9–12 und 14–15:30 Uhr, Fr 9–13 Uhr', 'Bonifazius-Turm A, Rhabanusstraße 3, 55118 Mainz'],
      },
      {
        titel: 'Polizei Mainz',
        text: 'Polizeipräsidium Mainz – außerhalb der Dienstzeiten des Verkehrsüberwachungsamts. Bei unmittelbarer Gefahr 110.',
        nummern: [['06131 65-0', 'tel:+496131650'], ['110', 'tel:110']],
      },
    ],
    versand: `<p>Mainz bearbeitet Privatanzeigen seit dem 22. Mai 2025 <strong>nur noch über das Online-Formular</strong>
      der Stadt – Anzeigen per E-Mail oder Post werden nicht mehr bearbeitet. Der OWiA-Anzeiger füllt dieses Formular
      für dich aus: Fotos, Tatort, Uhrzeit und Verstoß kommen aus deinem Entwurf, die Anzeige geht an das
      Verkehrsüberwachungsamt. Du bekommst eine Bestätigung mit allen übermittelten Angaben.</p>`,
    stadtteile: ['Altstadt', 'Neustadt', 'Oberstadt', 'Hartenberg-Münchfeld', 'Gonsenheim', 'Bretzenheim', 'Mombach',
      'Weisenau', 'Laubenheim', 'Hechtsheim', 'Ebersheim', 'Finthen', 'Drais', 'Lerchenberg', 'Marienborn'],
    faq: [
      ['Wen rufe ich in Mainz bei Falschparkern an?',
       'Während der Dienstzeiten das Verkehrsüberwachungsamt unter 06131 12-2181 oder 06131 12-3086, sonst die Polizei Mainz unter 06131 65-0. Bei unmittelbarer Gefahr wählst du 110.'],
      ['Kann ich Falschparker in Mainz per E-Mail anzeigen?',
       'Nein. Seit Mai 2025 nimmt Mainz Privatanzeigen nur noch über das Online-Formular der Stadt an. Der OWiA-Anzeiger übermittelt deine Anzeige über genau dieses Formular.'],
      ['Gehören Kastel und Kostheim zu Mainz?',
       'Nein, Mainz-Kastel, Mainz-Kostheim und Mainz-Amöneburg gehören zur Stadt Wiesbaden. Verstöße dort gehen an die Wiesbadener Verwarngeldstelle.'],
      ['Was kostet die Anzeige?',
       'Nichts – weder bei der Stadt Mainz noch beim OWiA-Anzeiger.'],
    ],
    quellen: [
      ['mainz.de: Verkehrsüberwachungsamt', 'https://www.mainz.de/en/vv/oe/verkehrsueberwachungsamt'],
      ['mainz.de: Verkehrsordnungswidrigkeit im ruhenden Verkehr anzeigen', 'https://www.mainz.de/en/vv/produkte/verkehrsueberwachung/verkehrsordnungswidrigkeit-im-ruhenden-verkehr-anzeigen'],
    ],
  },
  {
    id: 'hamburg',
    slug: 'falschparker-melden-hamburg',
    name: 'Hamburg',
    bundesland: 'Hamburg',
    behoerde: 'Bußgeldstelle der Behörde für Inneres und Sport',
    anruf: ['040 4286-50', 'tel:+4940428650', 'Polizei Hamburg'],
    kontakte: [
      {
        titel: 'Polizei Hamburg',
        text: 'In Hamburg veranlasst die Polizei das Abschleppen. Für akute Behinderungen das örtliche Polizeikommissariat oder die Telefonvermittlung anrufen, bei unmittelbarer Gefahr 110.',
        nummern: [['040 4286-50', 'tel:+4940428650'], ['110', 'tel:110']],
      },
      {
        titel: 'Bußgeldstelle Hamburg',
        text: 'Zuständig für Privatanzeigen (nicht für akute Fälle).',
        nummern: [],
        zeilen: ['Hammer Straße 30–34, 22041 Hamburg'],
      },
    ],
    versand: `<p>Die Bußgeldstelle bittet darum, Anzeigen über den <strong>Online-Dienst im Hamburger Serviceportal</strong>
      einzureichen, weil sie dort schneller geprüft werden. Der OWiA-Anzeiger füllt dieses Formular für dich aus.
      Gut zu wissen:</p>
      <ul>
        <li>Hamburg verlangt die Bestätigung, dass du vom Verstoß <strong>persönlich betroffen</strong> bist.</li>
        <li>Deine Anschrift muss deine Meldeanschrift sein.</li>
        <li>Es gehen höchstens drei Beweisfotos mit; Unbeteiligte und fremde Kennzeichen dürfen nicht erkennbar sein –
        im OWiA-Anzeiger schwärzt du sie vor dem Absenden.</li>
        <li>Verstöße mit Unfall nimmt nur die Polizei auf.</li>
      </ul>`,
    stadtteile: ['Hamburg-Mitte', 'Altona', 'Eimsbüttel', 'Hamburg-Nord', 'Wandsbek', 'Bergedorf', 'Harburg',
      'St. Pauli', 'Ottensen', 'Winterhude', 'Eppendorf', 'Barmbek', 'Wilhelmsburg'],
    faq: [
      ['Wen rufe ich in Hamburg bei Falschparkern an?',
       'Die Polizei: das örtliche Polizeikommissariat oder die Telefonvermittlung unter 040 4286-50. Sie kann das Fahrzeug abschleppen lassen. Bei unmittelbarer Gefahr wählst du 110.'],
      ['Wo zeige ich Falschparker in Hamburg an?',
       'Bei der Bußgeldstelle der Behörde für Inneres und Sport, am besten über den Online-Dienst im Hamburger Serviceportal. Der OWiA-Anzeiger übermittelt deine Anzeige über dieses Formular.'],
      ['Muss ich in Hamburg persönlich betroffen sein?',
       'Ja, das Hamburger Formular verlangt die Bestätigung, dass du von dem Verstoß persönlich betroffen bist – etwa weil du auf dem zugeparkten Gehweg oder Radweg unterwegs warst.'],
      ['Wie viele Fotos darf ich mitschicken?',
       'Höchstens drei. Auf den Fotos dürfen keine unbeteiligten Personen oder fremden Kennzeichen erkennbar sein.'],
      ['Wo ist mein abgeschlepptes Auto in Hamburg?',
       'Abgeschleppte Fahrzeuge kommen in der Regel zur Zentralen Verwahrstelle der Polizei; Auskunft gibt das zuständige Polizeikommissariat.'],
    ],
    quellen: [
      ['hamburg.de: Privatanzeigen', 'https://www.hamburg.de/politik-und-verwaltung/behoerden/behoerde-fuer-inneres-und-sport/privatanzeigen-92230'],
      ['polizei.hamburg: Kontakt', 'https://www.polizei.hamburg/kontakt'],
    ],
  },
  {
    id: 'hanau',
    slug: 'falschparker-melden-hanau',
    name: 'Hanau',
    bundesland: 'Hessen',
    behoerde: 'Ordnungsamt der Stadt Hanau (Verwarngeldstelle)',
    anruf: ['06181 2950-1900', 'tel:+49618129501900', 'Stadtpolizei · Mo–Sa 6:30–22 Uhr'],
    kontakte: [
      {
        titel: 'Stadtpolizei Hanau',
        text: 'Für dringende Fälle während der Dienstzeiten.',
        nummern: [['06181 2950-1900', 'tel:+49618129501900']],
        zeilen: ['Mo–Sa 6:30–22 Uhr', 'Am Markt 14–18, 63450 Hanau'],
      },
      {
        titel: 'Polizeirevier Hanau',
        text: 'Rund um die Uhr erreichbar – nachts, sonntags oder wenn die Stadtpolizei nicht erreichbar ist. Bei unmittelbarer Gefahr 110.',
        nummern: [['06181 100-120', 'tel:+496181100120'], ['110', 'tel:110']],
      },
      {
        titel: 'Verwarngeldstelle Hanau',
        text: 'Fragen zu Anzeigen und Verfahren (nicht für akute Fälle).',
        nummern: [['06181 2950-2110', 'tel:+49618129502110']],
        zeilen: ['Steinheimer Str. 1b, 63450 Hanau'],
      },
    ],
    versand: `<p>Der OWiA-Anzeiger schickt deine Anzeige mit allen Angaben und Beweisfotos per E-Mail an die
      <strong>Verwarngeldstelle der Stadt Hanau</strong>. Du bekommst eine Kopie bzw. Bestätigung mit allen
      übermittelten Angaben; Antworten der Stadt siehst du direkt in der App.</p>`,
    stadtteile: ['Innenstadt', 'Kesselstadt', 'Lamboy', 'Nordwest', 'Steinheim', 'Klein-Auheim', 'Großauheim',
      'Wolfgang', 'Mittelbuchen'],
    faq: [
      ['Wen rufe ich in Hanau bei Falschparkern an?',
       'Die Stadtpolizei Hanau unter 06181 2950-1900 (Mo–Sa 6:30–22 Uhr). Außerhalb dieser Zeiten das Polizeirevier Hanau unter 06181 100-120, bei unmittelbarer Gefahr 110.'],
      ['Wie zeige ich Falschparker in Hanau an?',
       'Mit Fotos, Ort, Zeit und Kennzeichen bei der Verwarngeldstelle der Stadt. Mit dem OWiA-Anzeiger geht das kostenlos online – die Anzeige wird per E-Mail an die Verwarngeldstelle übermittelt.'],
      ['Werden anonyme Anzeigen bearbeitet?',
       'Nein. Du wirst gegenüber der Stadt als Zeugin oder Zeuge mit Name und Anschrift benannt.'],
    ],
    quellen: [
      ['hanau.de: Verwarngeldstelle', 'https://www.hanau.de/contentpool/adressen/172250.html'],
      ['hanau.de: Stadtpolizei', 'https://www.hanau.de/contentpool/adressen/001438.html'],
      ['polizei.hessen.de: Polizeirevier Hanau', 'https://www.polizei.hessen.de/service/welche-polizei-vor-ort-ist-zustaendig/polizeirevier-hanau-hanau'],
    ],
  },
  {
    id: 'badsoden',
    slug: 'falschparker-melden-bad-soden-salmuenster',
    name: 'Bad Soden-Salmünster',
    bundesland: 'Hessen',
    behoerde: 'Ordnungsamt der Stadt Bad Soden-Salmünster',
    anruf: ['06056 733-921', 'tel:+496056733921', 'Ordnungsamt · zu den Öffnungszeiten'],
    kontakte: [
      {
        titel: 'Ordnungsamt Bad Soden-Salmünster',
        text: 'Fachbereich Ordnung und Straßenverkehr mit Ordnungspolizei.',
        nummern: [['06056 733-921', 'tel:+496056733921'], ['06056 733-40', 'tel:+49605673340']],
        zeilen: ['Mo, Mi 8:30–12 Uhr · Di 8:30–12 und 13–16 Uhr · Do 8:30–12 und 13–18 Uhr · Fr 8:30–13 Uhr', 'Rathausstraße 1, 63628 Bad Soden-Salmünster'],
      },
      {
        titel: 'Polizeistation Bad Orb',
        text: 'Zuständig auch für Bad Soden-Salmünster, rund um die Uhr erreichbar. Bei unmittelbarer Gefahr 110.',
        nummern: [['06052 9148-0', 'tel:+49605291480'], ['110', 'tel:110']],
      },
    ],
    versand: `<p>Der OWiA-Anzeiger schickt deine Anzeige mit allen Angaben und Beweisfotos per E-Mail an das
      <strong>Ordnungsamt der Stadt Bad Soden-Salmünster</strong> – auch für die Stadtteile wie Salmünster, Ahl oder
      Mernes. Du bekommst eine Bestätigung mit allen übermittelten Angaben.</p>
      <p class="small text-muted">Nicht zu verwechseln mit Bad Soden am Taunus.</p>`,
    stadtteile: ['Bad Soden', 'Salmünster', 'Ahl', 'Alsberg', 'Hausen', 'Katholisch-Willenroth', 'Kerbersdorf',
      'Mernes', 'Romsthal', 'Eckardroth', 'Wahlert'],
    faq: [
      ['Wen rufe ich in Bad Soden-Salmünster bei Falschparkern an?',
       'Zu den Öffnungszeiten das Ordnungsamt unter 06056 733-921. Außerhalb dieser Zeiten ist die Polizeistation Bad Orb unter 06052 9148-0 zuständig, bei unmittelbarer Gefahr 110.'],
      ['Wie zeige ich Falschparker in Bad Soden-Salmünster an?',
       'Mit Fotos, Ort, Zeit und Kennzeichen beim Ordnungsamt der Stadt. Mit dem OWiA-Anzeiger geht das kostenlos online, die Anzeige wird per E-Mail übermittelt.'],
    ],
    quellen: [
      ['badsoden-salmuenster.de: Kontakte', 'https://www.badsoden-salmuenster.de/top-menue/kontakte.html'],
      ['polizei.hessen.de: Polizeistation Bad Orb', 'https://www.polizei.hessen.de/service/welche-polizei-vor-ort-ist-zustaendig/polizeistation-bad-orb-bad-orb'],
    ],
  },
]

/** Stadtseiten mit eigener Ratgeber-View (alle außer Frankfurt). */
export const STADT_SEITEN_GENERISCH = STADT_SEITEN.filter((s) => s.id !== 'frankfurt')
