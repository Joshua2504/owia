# YOLOv11-Kennzeichen-Detektion über onnxruntime — bewusst OHNE torch/ultralytics:
# torch+paddle im selben Prozess segfaulten auf aarch64, und die offiziellen
# paddle-Wheels verlangen AVX, das der Produktionshost nicht bietet. ONNX läuft
# ohne Sonderanforderungen auf x86_64 wie aarch64.
#
# Preprocessing (Letterbox auf 640x640, BGR->RGB, /255) und Decoding (Ausgabe
# (1, 4+nc, 8400): cx/cy/w/h + Klassen-Scores, hier nc=1) entsprechen exakt dem
# Ultralytics-Export; NMS übernimmt cv2.dnn.NMSBoxes.
from __future__ import annotations

import cv2
import numpy as np
import onnxruntime as ort


class PlateDetector:
    def __init__(self, model_path: str, imgsz: int = 640):
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 2  # CPU wird mit dem Tileserver geteilt
        self.session = ort.InferenceSession(
            model_path, sess_options=opts, providers=["CPUExecutionProvider"]
        )
        self.input_name = self.session.get_inputs()[0].name
        self.imgsz = imgsz

    def detect(
        self, img: np.ndarray, conf_min: float = 0.35, iou: float = 0.45
    ) -> list[tuple[float, list[float]]]:
        """Kennzeichen-Boxen als [(score, [x1, y1, x2, y2]), ...], beste zuerst."""
        h0, w0 = img.shape[:2]
        scale = min(self.imgsz / h0, self.imgsz / w0)
        nh, nw = round(h0 * scale), round(w0 * scale)
        top, left = (self.imgsz - nh) // 2, (self.imgsz - nw) // 2

        canvas = np.full((self.imgsz, self.imgsz, 3), 114, dtype=np.uint8)
        canvas[top : top + nh, left : left + nw] = cv2.resize(
            img, (nw, nh), interpolation=cv2.INTER_LINEAR
        )
        blob = canvas[:, :, ::-1].astype(np.float32) / 255.0
        blob = np.ascontiguousarray(blob.transpose(2, 0, 1))[None]

        pred = self.session.run(None, {self.input_name: blob})[0][0]
        if pred.shape[0] < pred.shape[1]:  # (4+nc, 8400) -> (8400, 4+nc)
            pred = pred.T

        scores = pred[:, 4:].max(axis=1)
        keep = scores >= conf_min
        boxes, scores = pred[keep, :4], scores[keep]
        if boxes.shape[0] == 0:
            return []

        # cx/cy/w/h -> x/y/w/h (Letterbox-Koordinaten) für NMS
        rects = np.concatenate([boxes[:, :2] - boxes[:, 2:] / 2, boxes[:, 2:]], axis=1)
        idxs = cv2.dnn.NMSBoxes(rects.tolist(), scores.tolist(), conf_min, iou)

        results: list[tuple[float, list[float]]] = []
        for i in np.asarray(idxs).flatten():
            x, y, w, h = rects[i]
            x1 = max(0.0, float((x - left) / scale))
            y1 = max(0.0, float((y - top) / scale))
            x2 = min(float(w0), float((x + w - left) / scale))
            y2 = min(float(h0), float((y + h - top) / scale))
            if x2 <= x1 or y2 <= y1:
                continue
            results.append((float(scores[i]), [x1, y1, x2, y2]))

        results.sort(key=lambda t: t[0], reverse=True)
        return results
