FROM python:3.11-slim

# Laufzeitbibliotheken für OpenCV (kein GUI-Stack nötig).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Gesichtserkennung (YuNet, MIT, ~230 KB) für die Datenschutz-Prüfung.
ADD https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx /app/models/face_detection_yunet_2023mar.onnx

# Warmup lädt Detektor- und OCR-Modell beim Build ins Image (kein Download
# zur Laufzeit).
COPY districts.py plate.py segment.py app.py warmup.py ./
RUN python warmup.py

# CPU wird mit dem Tileserver geteilt – Thread-Zahl der BLAS/OMP-Pools begrenzen.
ENV OMP_NUM_THREADS=2

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
