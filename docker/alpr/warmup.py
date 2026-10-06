# Lädt beide Modelle beim Docker-Build (Download in den Image-Cache unter
# ~/.cache, passiert beim Import von app) und führt eine Dummy-Inferenz aus:
# zur Laufzeit ist kein externer Netzwerkzugriff nötig, und Installationsfehler
# brechen schon den Build ab statt erst den ersten Request.
import numpy as np

import app

dummy = np.full((480, 640, 3), 128, dtype=np.uint8)
app.detector.predict(dummy)
app.read_plate(dummy, [100, 200, 400, 270])
print("Modelle gecached und lauffähig.")
