# Lädt die ONNX-Modelle (Plattendetektor + OCR) beim Docker-Build herunter und
# legt sie im Image-Cache ab, damit zur Laufzeit kein Download nötig ist – der
# Dienst kommt im Betrieb ohne externen Netzwerkzugriff aus.
from fast_alpr import ALPR

ALPR()
print("ALPR-Modelle gecached.")
