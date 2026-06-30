# Schlanker HTTP-Wrapper um fast-alpr (https://github.com/ankandrew/fast-alpr, MIT).
# Eine POST-Route nimmt ein Bild entgegen und liefert das wahrscheinlichste
# Kennzeichen als JSON zurück. Läuft selbst-gehostet im Docker-Netz; das Bild
# verlässt den Host nie.
import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile
from fast_alpr import ALPR

app = FastAPI(title="OWiA ALPR")

# Modell einmalig beim Start laden (Standardmodelle, beim Build vorgecached).
alpr = ALPR()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/recognize")
async def recognize(file: UploadFile = File(...)):
    data = await file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"plate": None, "confidence": None}

    results = alpr.predict(img)

    # Beste Kandidatur nach OCR-Konfidenz wählen.
    best_text = None
    best_conf = -1.0
    for r in results:
        ocr = getattr(r, "ocr", None)
        text = getattr(ocr, "text", None) if ocr is not None else None
        if not text:
            continue
        conf = float(getattr(ocr, "confidence", 0.0) or 0.0)
        if conf > best_conf:
            best_conf = conf
            best_text = text

    if best_text is None:
        return {"plate": None, "confidence": None}
    return {"plate": best_text, "confidence": round(max(best_conf, 0.0), 3)}
