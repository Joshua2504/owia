# HTTP-Wrapper um YOLOv11 (Kennzeichen-Detektion, onnxruntime) + RapidOCR
# (PP-OCRv5-Latin-Recognition als ONNX). Eine POST-Route nimmt ein Bild entgegen
# und liefert die erkannten Kennzeichen als JSON. Läuft selbst-gehostet im
# Docker-Netz; das Bild verlässt den Host nie. Bewusst ohne torch/paddle
# (Begründung in detector.py).
import base64
import threading

import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile
from rapidocr import RapidOCR
from rapidocr.utils.typings import LangRec, ModelType, OCRVersion

from detector import PlateDetector
from plate import normalize

MODEL_PATH = "models/license-plate-finetune-v1s.onnx"
DET_CONF_MIN = 0.35

app = FastAPI(title="OWiA ALPR (YOLOv11 + PP-OCRv5, ONNX)")

# Modelle einmalig beim Start laden (beim Build vorgecached, kein Download).
detector = PlateDetector(MODEL_PATH)
# Nur Recognition auf dem YOLO-Crop; "latin" deckt Ö/Ü der Kreiskürzel ab.
recognizer = RapidOCR(
    params={
        "Rec.lang_type": LangRec.LATIN,
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Rec.model_type": ModelType.MOBILE,
    }
)

# Inferenz serialisieren: eine Anfrage darf die CPU nutzen, weitere warten.
inference_lock = threading.Lock()


def crop_plate(img: np.ndarray, xyxy: list) -> tuple:
    """Enger Kennzeichen-Crop. Ohne Rand: hineinragende Umgebung (EU-Band,
    Stoßstange) verschlechtert die OCR messbar."""
    h, w = img.shape[:2]
    x1, y1 = max(0, int(xyxy[0])), max(0, int(xyxy[1]))
    x2, y2 = min(w, int(xyxy[2])), min(h, int(xyxy[3]))
    return img[y1:y2, x1:x2], [x1, y1, x2, y2]


def encode_crop(crop: np.ndarray) -> str | None:
    """Kennzeichen-Ausschnitt als Base64-JPEG (wird von der App pro Bild als
    eigene Beweisdatei neben dem Foto gespeichert)."""
    ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else None


def read_text(crop: np.ndarray) -> tuple:
    """Beste OCR-Lesung des Crops als (text, score)."""
    res = recognizer(crop, use_det=False, use_cls=False, use_rec=True)
    best_text, best_score = "", 0.0
    for text, score in zip(res.txts or [], res.scores or []):
        if text and float(score) > best_score:
            best_text, best_score = str(text), float(score)
    return best_text, best_score


def read_plate(crop: np.ndarray) -> dict | None:
    """Liest den Crop in zwei Varianten (Original + 2x hochskaliert) und liefert
    die beste Lesung: normalisierte schlagen unnormalisierte, dann zählt der Score."""
    variants = [crop]
    if crop.shape[0] > 0:
        variants.append(cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))
    best = None
    for variant in variants:
        raw_text, ocr_conf = read_text(variant)
        if not raw_text:
            continue
        text, normalized = normalize(raw_text)
        if not text:
            continue
        candidate = {
            "text": text,
            "raw_text": raw_text,
            "normalized": normalized,
            "ocr_confidence": ocr_conf,
        }
        if best is None or (normalized, ocr_conf) > (best["normalized"], best["ocr_confidence"]):
            best = candidate
    return best


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
        for det_conf, xyxy in detector.detect(img, conf_min=DET_CONF_MIN):
            crop, bbox = crop_plate(img, xyxy)
            if crop.size == 0:
                continue
            reading = read_plate(crop)
            if not reading:
                continue
            # Konfidenz = OCR-Score: Eine formatgültige, gegen die Kürzel-Liste
            # validierte Lesung belegt selbst, dass die Box ein Kennzeichen war —
            # det_conf gated bereits über DET_CONF_MIN und würde multiplikativ
            # nur sichere Lesungen unter die Prefill-Schwelle drücken. Nicht
            # normalisierbare Lesungen werden abgewertet: sie bleiben sichtbar,
            # fallen aber unter die Prefill-Schwelle der App.
            confidence = reading["ocr_confidence"] * (1.0 if reading["normalized"] else 0.5)
            plates.append({
                "text": reading["text"],
                "raw_text": reading["raw_text"],
                "normalized": reading["normalized"],
                "det_confidence": round(det_conf, 3),
                "ocr_confidence": round(reading["ocr_confidence"], 3),
                "confidence": round(confidence, 3),
                "bbox": [int(v) for v in bbox],
                "crop": encode_crop(crop),
            })

    plates.sort(key=lambda p: p["confidence"], reverse=True)
    return {"plates": plates, "best": plates[0] if plates else None}
