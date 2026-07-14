FROM python:3.11-slim

# Laufzeitbibliotheken für OpenCV (kein GUI-Stack nötig).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# YOLO-Modell beim Build ins Image backen (kein Download zur Laufzeit).
COPY download_model.py .
RUN python download_model.py

# Warmup lädt auch die RapidOCR-ONNX-Modelle in den Image-Cache.
COPY districts.py plate.py detector.py app.py warmup.py ./
RUN python warmup.py

# CPU wird mit dem Tileserver geteilt – Thread-Zahl der BLAS/OMP-Pools begrenzen.
ENV OMP_NUM_THREADS=2

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
