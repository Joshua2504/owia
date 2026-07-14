# Lädt beide Modelle beim Docker-Build einmal und führt eine Dummy-Inferenz aus:
# PaddleOCR lädt sein Recognition-Modell dabei in den Image-Cache (~/.paddlex),
# und Installationsfehler brechen schon den Build ab statt erst den ersten Request.
import numpy as np
from paddleocr import TextRecognition
from ultralytics import YOLO

detector = YOLO("models/license-plate-finetune-v1s.pt")
recognizer = TextRecognition(model_name="latin_PP-OCRv5_mobile_rec")

dummy = np.zeros((96, 320, 3), dtype=np.uint8)
detector.predict(dummy, verbose=False)
recognizer.predict(input=dummy)
print("Modelle gecached und lauffähig.")
