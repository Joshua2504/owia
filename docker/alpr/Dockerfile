FROM python:3.11-slim

# Laufzeitbibliotheken für OpenCV (libGL/glib), die fast-alpr/opencv benötigt.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY warmup.py app.py ./
# ONNX-Modelle beim Build ins Image backen (kein Download zur Laufzeit).
RUN python warmup.py

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
