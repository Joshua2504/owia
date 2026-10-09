-- Seitenaufrufe & Wege (services/aufrufe.ts, Seite /admin/aufrufe).
-- Bewusst nur Tageszähler je (Seite, Herkunft): keine IP, kein User-Agent,
-- keine Nutzer-ID, kein Cookie, keine Einzelzeile je Aufruf – aus der Tabelle
-- lässt sich kein Besuch und kein Besucher rekonstruieren. `pfad` ist das
-- Routen-Muster (`/anzeige/:az`), nie die konkrete URL; `von` ist das Muster
-- der vorigen eigenen Seite, `extern:<host>` oder `direkt`.
CREATE TABLE IF NOT EXISTS seitenaufrufe (
  tag     DATE NOT NULL,
  pfad    VARCHAR(191) NOT NULL,
  von     VARCHAR(191) NOT NULL,
  anzahl  INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (tag, pfad, von)
);
