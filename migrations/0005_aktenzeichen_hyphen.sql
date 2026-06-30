-- Aktenzeichen werden jetzt in Links/URLs verwendet und dürfen kein '#'
-- enthalten (Fragment-Zeichen). Bestehende Aktenzeichen von "OWiAA#XXXXXX"
-- auf "OWiAA-XXXXXX" umstellen.
UPDATE reports SET aktenzeichen = REPLACE(aktenzeichen, '#', '-') WHERE aktenzeichen LIKE '%#%';
