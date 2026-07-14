# HTTP-Wrapper um YOLOv11 (Kennzeichen-Detektion) + PaddleOCR (Texterkennung).
# Eine POST-Route nimmt ein Bild entgegen und liefert die erkannten Kennzeichen
# als JSON. Läuft selbst-gehostet im Docker-Netz; das Bild verlässt den Host nie.
import threading

import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile
from paddleocr import TextRecognition
from ultralytics import YOLO

from plate import normalize

MODEL_PATH = "models/license-plate-finetune-v1s.pt"
DET_CONF_MIN = 0.35

app = FastAPI(title="OWiA ALPR (YOLOv11 + PaddleOCR)")

# Modelle einmalig beim Start laden (beim Build vorgecached, kein Download).
detector = YOLO(MODEL_PATH)
# Nur Recognition auf dem YOLO-Crop; "latin" deckt Ö/Ü der Kreiskürzel ab.
recognizer = TextRecognition(model_name="latin_PP-OCRv5_mobile_rec")

# Inferenz serialisieren: eine Anfrage darf die CPU nutzen, weitere warten.
inference_lock = threading.Lock()


def crop_plate(img: np.ndarray, xyxy: list[float]) -> tuple[np.ndarray, list[int]]:
    """Kennzeichen-Crop mit 12 % Rand; kleine Crops für die OCR hochskalieren."""
    h, w = img.shape[:2]
    x1, y1, x2, y2 = xyxy
    pad_x, pad_y = (x2 - x1) * 0.12, (y2 - y1) * 0.12
    x1, y1 = max(0, int(x1 - pad_x)), max(0, int(y1 - pad_y))
    x2, y2 = min(w, int(x2 + pad_x)), min(h, int(y2 + pad_y))
    crop = img[y1:y2, x1:x2]
    if 0 < crop.shape[0] < 48:
        scale = 96 / crop.shape[0]
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    return crop, [x1, y1, x2, y2]


def read_text(crop: np.ndarray) -> tuple[str, float]:
    """Beste OCR-Lesung des Crops als (text, score)."""
    best_text, best_score = "", 0.0
    for res in recognizer.predict(input=crop):
        text = str(res.get("rec_text") or "")
        score = float(res.get("rec_score") or 0.0)
        if text and score > best_score:
            best_text, best_score = text, score
    return best_text, best_score


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/recognize")
async def recognize(file: UploadFile = File(...)):
    data = await file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"plates": [], "best": None}

    plates = []
    with inference_lock:
        results = detector.predict(img, conf=DET_CONF_MIN, verbose=False)
        for result in results:
            for box in result.boxes:
                det_conf = float(box.conf[0])
                crop, bbox = crop_plate(img, box.xyxy[0].tolist())
                if crop.size == 0:
                    continue
                raw_text, ocr_conf = read_text(crop)
                if not raw_text:
                    continue
                text, normalized = normalize(raw_text)
                if not text:
                    continue
                # Nicht normalisierbare Lesungen abwerten: sie bleiben sichtbar,
                # fallen aber unter die Prefill-Schwelle der App.
                confidence = det_conf * ocr_conf * (1.0 if normalized else 0.5)
                plates.append({
                    "text": text,
                    "raw_text": raw_text,
                    "normalized": normalized,
                    "det_confidence": round(det_conf, 3),
                    "ocr_confidence": round(ocr_conf, 3),
                    "confidence": round(confidence, 3),
                    "bbox": bbox,
                })

    plates.sort(key=lambda p: p["confidence"], reverse=True)
    return {"plates": plates, "best": plates[0] if plates else None}
