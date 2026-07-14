-- "Wurde jemand behindert?" hat jetzt den Standard "Nein" (0) statt "keine
-- Angabe" (NULL). Damit ist im PDF immer eine der beiden Checkboxen angekreuzt.
-- Bestand: NULL -> 0 (das Formular zeigte dafür bereits "Nein" an).

UPDATE reports SET behinderung = 0 WHERE behinderung IS NULL;

ALTER TABLE reports MODIFY behinderung TINYINT(1) NOT NULL DEFAULT 0;
