# Lädt beide Modelle beim Docker-Build einmal und führt eine Dummy-Inferenz aus:
# RapidOCR lädt seine ONNX-Modelle dabei in den Image-Cache (site-packages),
# und Installationsfehler brechen schon den Build ab statt erst den ersten Request.
import numpy as np
from rapidocr import RapidOCR
from rapidocr.utils.typings import LangRec, ModelType, OCRVersion

from detector import PlateDetector

detector = PlateDetector("models/license-plate-finetune-v1s.onnx")
recognizer = RapidOCR(
    params={
        "Rec.lang_type": LangRec.LATIN,
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        "Rec.model_type": ModelType.MOBILE,
    }
)

dummy = np.zeros((96, 320, 3), dtype=np.uint8)
detector.detect(dummy)
recognizer(dummy, use_det=False, use_cls=False, use_rec=True)
print("Modelle gecached und lauffähig.")
