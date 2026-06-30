// Katalog der wählbaren Verstoßarten. Eigenes Modul (statt in reports.ts), damit
// sowohl die Routen als auch die Analyse-Services (vlm.ts) die Liste nutzen können,
// ohne einen Import-Zyklus Route↔Service zu erzeugen.
export const VERSTOSS_ARTEN = [
  'Parken auf dem Gehweg',
  'Parken im absoluten Halteverbot (Zeichen 283)',
  'Parken im eingeschränkten Halteverbot (Zeichen 286)',
  'Parken in der zweiten Reihe',
  'Halten und Parken auf einem Radweg',
  'Parken auf einem Sonderfahrstreifen (Busspur/Radweg)',
  'Parken vor einer abgesenkten Bordsteinkante',
  'Parken in einer Feuerwehrzufahrt',
  'Parken auf einem Behindertenparkplatz ohne Ausweis',
  'Parken an einer Kreuzung oder Einmündung',
  'Sonstiges',
]
