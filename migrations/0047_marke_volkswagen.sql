-- „VW" und „Volkswagen" sind dieselbe Marke: Bestand vereinheitlichen, damit
-- Analyse/Statistik nicht doppelt zählen. Gleiche Regel wie markeNormalisieren()
-- in src/config/fahrzeug.ts (führendes „VW"/„V.W." → „Volkswagen", Rest bleibt:
-- „VW Caddy" → „Volkswagen Caddy"). Wiederholbar: danach trifft nichts mehr.
UPDATE reports
   SET fahrzeug_marke = REGEXP_REPLACE(fahrzeug_marke, '^(?i)(vw|v\\.\\s?w\\.?)(?=\\s|$)', 'Volkswagen')
 WHERE fahrzeug_marke REGEXP '^(?i)(vw|v\\.\\s?w\\.?)(\\s|$)';
