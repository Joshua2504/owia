FROM python:3.11-slim

# Laufzeitbibliotheken für OpenCV/Paddle (kein GUI-Stack nötig).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Torch zuerst als CPU-Wheel, sonst zieht ultralytics die CUDA-Variante (+~2,5 GB).
RUN pip install --no-cache-dir torch==2.13.0 torchvision==0.28.0 \
      --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Modelle beim Build ins Image backen (kein Download zur Laufzeit).
COPY download_model.py .
RUN python download_model.py

COPY districts.py plate.py app.py warmup.py ./
RUN python warmup.py

# CPU wird mit dem Tileserver geteilt – Thread-Zahl der BLAS/OMP-Pools begrenzen.
ENV OMP_NUM_THREADS=2
# Kein Konnektivitäts-Check zu den Modell-Hostern beim Start – die Modelle
# liegen bereits im Image, der Dienst braucht zur Laufzeit kein Internet.
ENV PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
