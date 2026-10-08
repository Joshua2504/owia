-- Frankfurt nimmt Anzeigen seit 10/2026 nur noch über das ekom21-Portal an
-- (services/portalDispatch.ts). Das Portal verlangt strukturierte Angaben, die
-- bisher als Freitext zusammengefasst waren.

-- Anzeigende Person: Anrede (Pflicht im Portal) und Hausnummer getrennt.
ALTER TABLE users ADD COLUMN IF NOT EXISTS anrede VARCHAR(10) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hausnummer VARCHAR(20) NULL;

-- Bestand: Hausnummer vom Ende der Straße abtrennen („Birminghamstraße 97",
-- „Am Hang 12 a", „Weg 3-5"). MariaDB wertet SET von links nach rechts aus,
-- hausnummer liest also noch die ungeteilte Straße.
UPDATE users
   SET hausnummer = TRIM(REGEXP_SUBSTR(strasse, '[0-9]+[ ]?[a-zA-Z]?([ ]?[-/][ ]?[0-9]+[ ]?[a-zA-Z]?)?$')),
       strasse = TRIM(REGEXP_REPLACE(strasse, '[ ]+[0-9]+[ ]?[a-zA-Z]?([ ]?[-/][ ]?[0-9]+[ ]?[a-zA-Z]?)?$', ''))
 WHERE hausnummer IS NULL
   AND strasse REGEXP '[^0-9 ][ ]+[0-9]+[ ]?[a-zA-Z]?([ ]?[-/][ ]?[0-9]+[ ]?[a-zA-Z]?)?$';

-- Fahrzeug: Typ (Portal-Liste, NULL = PKW), Farbe und Modell getrennt von der Marke.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS fahrzeug_typ VARCHAR(40) NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS fahrzeug_farbe VARCHAR(40) NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS fahrzeug_modell VARCHAR(60) NULL;

-- Bestand „Marke, Farbe" (so schlug es das alte Feld vor) aufteilen.
UPDATE reports
   SET fahrzeug_farbe = TRIM(SUBSTRING(fahrzeug_marke, LOCATE(',', fahrzeug_marke) + 1)),
       fahrzeug_marke = TRIM(SUBSTRING(fahrzeug_marke, 1, LOCATE(',', fahrzeug_marke) - 1))
 WHERE fahrzeug_farbe IS NULL AND fahrzeug_marke LIKE '%,%';
UPDATE reports SET fahrzeug_farbe = NULL WHERE fahrzeug_farbe = '';

-- Konkretisierung des Tatbestands, wo der Katalog Alternativen offen lässt
-- („Kreuzung/Einmündung", „Zeichen 240/241"); Werte aus services/portalFfm.ts.
ALTER TABLE reports ADD COLUMN IF NOT EXISTS verstoss_variante VARCHAR(120) NULL;

-- Ergebnis des Portal-Versands: Vorgangs-ID und gespeicherte Zusammenfassung
-- (PDF bzw. Screenshot der Abschlussseite unter data/pdfs/<userId>/).
ALTER TABLE reports ADD COLUMN IF NOT EXISTS portal_vorgang_id VARCHAR(64) NULL;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS portal_beleg VARCHAR(255) NULL;
