# HTTP-Wrapper um die Kennzeichenerkennung: YOLOv9-Kennzeichen-Detektion
# (open-image-models) + spezialisiertes Kennzeichen-OCR (fast-plate-ocr,
# cct-s-v2), beide als ONNX. Eine POST-Route nimmt ein Bild entgegen und liefert
# die erkannten Kennzeichen als JSON. Läuft selbst-gehostet im Docker-Netz; das
# Bild verlässt den Host nie. Bewusst ohne torch/paddle (siehe requirements.txt).
#
# Gegenüber dem früheren Stack (YOLOv11 + allgemeines PP-OCRv5) liest das
# Kennzeichen-OCR die Plaketten nicht mehr als Buchstaben ("FB-TF" statt
# "F-TF") und kommt mit Nachtaufnahmen und zweizeiligen Schildern zurecht;
# gemessen an echten Anzeigefotos stieg die Trefferquote je Anzeige von 5/35
# auf 31/35 (Rest: Kennzeichen gar nicht im Bild).
import base64
import threading

import cv2
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, File, UploadFile
from fast_plate_ocr import LicensePlateRecognizer
from open_image_models import create_detector

from fahrzeug import Fahrzeug
from plate import normalize
from segment import district_length

DET_MODEL = "yolo-v9-s-608-license-plate-end2end"
OCR_MODEL = "cct-s-v2-global-model"
# Niedrig angesetzt: schwache Boxen (Nacht, schräg) sind oft echte Kennzeichen,
# und Fehlalarme fallen über OCR-Konfidenz + Formatprüfung ohnehin raus.
DET_CONF_MIN = 0.15
# Ab dieser Konfidenz gilt eine Lesung als sicher (entspricht dem Default von
# ALPR_MIN_CONFIDENCE der App); unter den sicheren gewinnt das größte Schild.
CONFIDENT = 0.75

app = FastAPI(title="OWiA ALPR (YOLOv9 + fast-plate-ocr, ONNX)")


def _session_options() -> ort.SessionOptions:
    opts = ort.SessionOptions()
    # Nur 2 Kerne für die Foto-Verarbeitung (Container ist per cpuset auf CPU
    # 2–3 gepinnt, s. docker-compose.yml) – keine Thread-Überbelegung.
    opts.intra_op_num_threads = 2
    opts.inter_op_num_threads = 1
    return opts


cv2.setNumThreads(2)


# Modelle einmalig beim Start laden (beim Build vorgecached, kein Download).
detector = create_detector(
    DET_MODEL, conf_thresh=DET_CONF_MIN, providers=["CPUExecutionProvider"], sess_options=_session_options()
)
recognizer = LicensePlateRecognizer(
    OCR_MODEL, providers=["CPUExecutionProvider"], sess_options=_session_options()
)

# Marke/Farbe (SigLIP2, s. fahrzeug.py); Kennzeichen bleiben die Hauptsache.
fahrzeug = Fahrzeug(_session_options())

# Inferenz serialisieren: eine Anfrage darf die CPU nutzen, weitere warten.
inference_lock = threading.Lock()

# Gesichter (Datenschutz-Prüfung vor dem Versand: Beweisfotos dürfen keine
# erkennbaren Personen zeigen). YuNet aus OpenCV-Zoo, beim Build ins Image geladen.
FACE_MODEL = "/app/models/face_detection_yunet_2023mar.onnx"
face_detector = cv2.FaceDetectorYN.create(FACE_MODEL, "", (320, 320), 0.8, 0.3, 5000)
FACE_MIN_PX = 24  # kleinere Gesichter sind auf Beweisfotos nicht identifizierbar


def detect_faces(img: np.ndarray) -> list:
    h, w = img.shape[:2]
    scale = min(1.0, 1280 / max(h, w))
    small = cv2.resize(img, (int(w * scale), int(h * scale))) if scale < 1 else img
    face_detector.setInputSize((small.shape[1], small.shape[0]))
    _, faces = face_detector.detect(small)
    out = []
    if faces is None:
        return out
    for f in faces:
        x, y, fw, fh, score = float(f[0]), float(f[1]), float(f[2]), float(f[3]), float(f[-1])
        if fw / scale < FACE_MIN_PX:
            continue
        box = [int(x / scale), int(y / scale), int((x + fw) / scale), int((y + fh) / scale)]
        out.append({"bbox": [max(0, box[0]), max(0, box[1]), min(w, box[2]), min(h, box[3])], "score": round(score, 3)})
    return out


def clip_box(img: np.ndarray, xyxy, pad_x: float = 0.0, pad_y: float = 0.0) -> list:
    h, w = img.shape[:2]
    x1, y1, x2, y2 = (float(v) for v in xyxy)
    px, py = (x2 - x1) * pad_x, (y2 - y1) * pad_y
    return [max(0, int(x1 - px)), max(0, int(y1 - py)), min(w, int(x2 + px)), min(h, int(y2 + py))]


def crop(img: np.ndarray, box: list) -> np.ndarray:
    return img[box[1] : box[3], box[0] : box[2]]


def encode_crop(c: np.ndarray) -> str | None:
    """Kennzeichen-Ausschnitt als Base64-JPEG (wird von der App pro Bild als
    eigene Beweisdatei neben dem Foto gespeichert)."""
    ok, buf = cv2.imencode(".jpg", c, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    return base64.b64encode(buf.tobytes()).decode("ascii") if ok else None


def read_plate(img: np.ndarray, xyxy) -> dict | None:
    # 10 % Rand: Das OCR-Modell liest leicht großzügige Crops messbar besser
    # als die oft knapp anliegende Detektor-Box.
    box = clip_box(img, xyxy, 0.1, 0.1)
    c = crop(img, box)
    if c.size == 0:
        return None
    pred = recognizer.run(cv2.cvtColor(c, cv2.COLOR_BGR2RGB), return_confidence=True)[0]
    raw = (pred.plate or "").replace("_", "")
    if not raw:
        return None
    probs = pred.char_probs[: len(pred.plate)] if pred.char_probs is not None else []
    # Konfidenz = unsicherstes Zeichen (ein einziges falsches Zeichen macht das
    # Kennzeichen falsch); trennt Fehllesungen deutlich schärfer als der Mittelwert.
    ocr_conf = float(np.min(probs)) if len(probs) else 0.0
    # Für die Lückenmessung oben/unten mehr Rand, damit keine Zeichen angeschnitten sind.
    seg = crop(img, clip_box(img, xyxy, 0.04, 0.15))
    text, normalized = normalize(raw, district_length(seg, raw))
    return {"text": text, "raw_text": raw, "normalized": normalized, "ocr_confidence": ocr_conf, "crop": c, "bbox": box}


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/recognize")
async def recognize(file: UploadFile = File(...)):
    data = await file.read()
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return {"plates": [], "best": None, "faces": [], "fahrzeug": None, "width": 0, "height": 0}
    h, w = img.shape[:2]

    plates = []
    with inference_lock:
        faces = detect_faces(img)
        for det in detector.predict(img):
            b = det.bounding_box
            xyxy = [b.x1, b.y1, b.x2, b.y2]
            reading = read_plate(img, xyxy)
            if not reading or not reading["text"]:
                continue
            confidence = reading["ocr_confidence"]
            # Nicht normalisierbare Lesungen bleiben sichtbar, fallen aber unter
            # die Prefill-Schwelle der App.
            if not reading["normalized"]:
                confidence *= 0.5
            # Am Bildrand angeschnittene Schilder liefern plausible, aber
            # unvollständige Lesungen ("F-P 619" statt "F-BP 6197").
            if b.x1 <= 2 or b.y1 <= 2 or b.x2 >= w - 2 or b.y2 >= h - 2:
                confidence *= 0.5
            plates.append({
                "text": reading["text"],
                "raw_text": reading["raw_text"],
                "normalized": reading["normalized"],
                "det_confidence": round(float(det.confidence), 3),
                "ocr_confidence": round(reading["ocr_confidence"], 3),
                "confidence": round(confidence, 3),
                "bbox": reading["bbox"],
                "width": int(b.x2 - b.x1),
                "crop": encode_crop(reading["crop"]),
            })

    # Bester Treffer: Unter den sicheren Lesungen das größte Schild – das
    # angezeigte Auto steht meist vorn im Bild, Kennzeichen anderer Autos im
    # Hintergrund sind kleiner. Ohne sichere Lesung zählt die Konfidenz.
    def rank(p):
        sure = p["normalized"] and p["confidence"] >= CONFIDENT
        return (sure, p["width"] if sure else p["confidence"])

    plates.sort(key=rank, reverse=True)
    for p in plates:
        del p["width"]

    # Marke/Farbe am Auto des besten Kennzeichens (dem angezeigten), sonst am
    # ganzen Foto. Fehler hier dürfen die Kennzeichen-Antwort nicht kosten.
    try:
        with inference_lock:
            vehicle = fahrzeug.classify(img, plates[0]["bbox"] if plates else None)
    except Exception:
        vehicle = None
    return {"plates": plates, "best": plates[0] if plates else None, "faces": faces, "fahrzeug": vehicle, "width": w, "height": h}
