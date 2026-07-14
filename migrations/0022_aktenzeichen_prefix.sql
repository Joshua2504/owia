-- Einheitliches Aktenzeichen-Präfix: Alt-Bestand "OWiAA-..." wird zu "OWiA-...".
-- Der Code-Teil bleibt unverändert (Eindeutigkeit bleibt erhalten). Hinweis:
-- alte Links/Lesezeichen mit dem bisherigen Aktenzeichen funktionieren danach
-- nicht mehr; bereits versendete Mails referenzieren das alte Zeichen.

UPDATE reports
   SET aktenzeichen = REPLACE(aktenzeichen, 'OWiAA-', 'OWiA-')
 WHERE aktenzeichen LIKE 'OWiAA-%';
