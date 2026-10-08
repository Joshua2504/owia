# Marke und Farbe des Fahrzeugs per Zero-Shot-Bildklassifikation (SigLIP2-base,
# Apache-2.0, ONNX). Das Bild wird mit vorab berechneten Text-Embeddings
# („a photo of a Volkswagen car." usw., s. fahrzeug_prompts.json) verglichen;
# ein Training ist nicht nötig.
#
# Ausschnitte orientieren sich am Kennzeichen des angezeigten Autos:
#  - "front": eng um Schild + Bereich darüber (dort sitzt das Logo)
#  - "car":   ganzes Heck bzw. ganze Front (~5 Schildbreiten)
#  - "full":  ganzes Foto
# Marke = car + front, Farbe = full + car. Gemessen an 160 Anzeigen mit von
# Hand eingetragenen Werten (10/2026): Marke 90 % Treffer je Anzeige, Farbe
# 80 % (87 %, wenn silber/grau als gleich gelten). Die App befüllt nur ab
# p >= 0,8 vor (Marke dann 98 %, Farbe 96 % richtig). Das Modell (innerhalb
# der Marke) ist mangels Vergleichsdaten ungemessen und wird nur als
# anklickbarer Vorschlag angeboten, nie vorbefüllt.
import cv2
import numpy as np
import onnxruntime as ort

MODEL = "/app/models/siglip2_vision.onnx"
TEXT = "/app/models/fahrzeug_text.npz"
SIZE = 224
# Fester Faktor für die Softmax über Kosinus-Ähnlichkeiten; die Schwellen der
# App (FAHRZEUG_MIN_P) sind mit genau diesem Wert gemessen – nicht ändern, ohne
# neu zu messen.
TEMPERATURE = 100.0
TOP = 5
# Modelle werden für die wahrscheinlichsten Marken des Fotos bewertet (die
# Marke der Anzeige kann der Nutzer anders eingetragen haben), je Marke Top 3.
MODELL_MARKEN = 3
MODELL_TOP = 3


class Fahrzeug:
    def __init__(self, sess_options: ort.SessionOptions):
        self.vision = ort.InferenceSession(MODEL, sess_options, providers=["CPUExecutionProvider"])
        t = np.load(TEXT)
        self.groups = {g: (list(t[f"{g}_names"]), t[g]) for g in ("marke", "farbe")}
        # Modelle je Marke: Labels "Marke|Modell" → {Marke: (Modelle, Embeddings)}
        names, vecs = list(t["modell_names"]), t["modell"]
        self.modelle = {}
        for marke in dict.fromkeys(n.split("|")[0] for n in names):
            idx = [i for i, n in enumerate(names) if n.split("|")[0] == marke]
            self.modelle[marke] = ([names[i].split("|", 1)[1] for i in idx], vecs[idx])

    @staticmethod
    def _prep(img: np.ndarray) -> np.ndarray:
        img = cv2.resize(img, (SIZE, SIZE), interpolation=cv2.INTER_LINEAR)
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255
        return ((img - 0.5) / 0.5).transpose(2, 0, 1)

    @staticmethod
    def _square(img: np.ndarray, cx: float, cy: float, side: float) -> np.ndarray:
        h, w = img.shape[:2]
        side = min(side, w, h)
        x1 = int(min(max(0, cx - side / 2), w - side))
        y1 = int(min(max(0, cy - side / 2), h - side))
        return img[y1 : y1 + int(side), x1 : x1 + int(side)]

    def _probs(self, group: str, embs: list, labels=None, top: int = TOP) -> dict:
        names, text = labels or self.groups[group]
        z = sum(e @ text.T for e in embs) * TEMPERATURE
        p = np.exp(z - z.max())
        p /= p.sum()
        top = np.argsort(-p)[:top]
        return {names[i]: round(float(p[i]), 4) for i in top}

    def classify(self, img: np.ndarray, plate_xyxy=None) -> dict:
        """Top-5-Wahrscheinlichkeiten je Gruppe: {"marke": {...}, "farbe": {...},
        "modell": {Marke: {Modell: p}}}.
        Ohne Kennzeichen wird für alle Ausschnitte das ganze Foto genommen."""
        crops = {"full": img}
        if plate_xyxy is not None:
            x1, y1, x2, y2 = (float(v) for v in plate_xyxy)
            pw, cx = x2 - x1, (x1 + x2) / 2
            crops["car"] = self._square(img, cx, (y1 + y2) / 2 - 0.9 * pw, 5 * pw)
            crops["front"] = self._square(img, cx, y1 - 0.5 * pw, 2.2 * pw)
        else:
            crops["car"] = crops["front"] = img
        keys = ("full", "car", "front")
        e = self.vision.run(None, {"pixel_values": np.stack([self._prep(crops[k]) for k in keys])})[-1]
        e /= np.linalg.norm(e, axis=1, keepdims=True)
        emb = dict(zip(keys, e))
        marke = self._probs("marke", [emb["car"], emb["front"]])
        # Modell: Softmax nur über die Modelle der jeweiligen Marke (dieselben
        # Ausschnitte wie die Marke; hinten hilft der Modellschriftzug).
        modell = {
            m: self._probs("modell", [emb["car"], emb["front"]], self.modelle[m], MODELL_TOP)
            for m in list(marke)[:MODELL_MARKEN]
            if m in self.modelle
        }
        return {
            "marke": marke,
            "farbe": self._probs("farbe", [emb["full"], emb["car"]]),
            "modell": modell,
        }
