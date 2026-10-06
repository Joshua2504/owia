# Lädt beide Modelle beim Docker-Build (Download in den Image-Cache unter
# ~/.cache) und führt eine Dummy-Inferenz aus: zur Laufzeit ist kein externer
# Netzwerkzugriff nötig, und Installationsfehler brechen schon den Build ab
# statt erst den ersten Request.
import cv2
import numpy as np
from fastapi.testclient import TestClient

import app

dummy = np.full((480, 640, 3), 128, dtype=np.uint8)
ok, buf = cv2.imencode(".jpg", dummy)
res = TestClient(app.app).post("/recognize", files={"file": ("x.jpg", buf.tobytes(), "image/jpeg")})
res.raise_for_status()
print("Modelle gecached und lauffähig:", res.json())
