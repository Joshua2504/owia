# Hier das offizielle Frankfurt-PDF-Formular als "formular.pdf" ablegen.
# Die AcroForm-Feldnamen können nach dem Start mit folgendem Befehl ausgelesen werden:
#
#   curl http://localhost:3000/debug/pdf-fields   (nur in NODE_ENV=development)
#
# Danach src/services/pdf.ts → fieldMap aktualisieren.
#
# bussgelder.csv: Regelsatz (Euro) je TBNR aus dem Bundeseinheitlichen
# Tatbestandskatalog des KBA (Stand 22.08.2024), für /statistik.
# Quelle: https://www.kba.de/DE/Themen/ZentraleRegister/FAER/BT_KAT_OWI/btkat_node.html
