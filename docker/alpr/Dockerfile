# Builder: Text-Embeddings für die Marken-/Farberkennung vorab rechnen (s.
# fahrzeug_text.py). Textmodell + Tokenizer bleiben in diesem Stage zurück.
FROM python:3.11-slim AS fahrzeug-text
ARG SIGLIP=https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX/resolve/ba1f3b0843f24bc5417d38e19c37b287d719b2f4
RUN pip install --no-cache-dir onnxruntime==1.27.0 tokenizers==0.22.1 numpy
ADD ${SIGLIP}/onnx/text_model_quantized.onnx /m/text_model.onnx
ADD ${SIGLIP}/tokenizer.json /m/tokenizer.json
COPY fahrzeug_prompts.json fahrzeug_text.py /m/
RUN python /m/fahrzeug_text.py /m /m/fahrzeug_prompts.json /m/fahrzeug_text.npz

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

# Marke/Farbe: SigLIP2-base-Bildmodell (Apache-2.0, ~370 MB) + vorab
# gerechnete Text-Embeddings aus dem Builder.
ARG SIGLIP=https://huggingface.co/onnx-community/siglip2-base-patch16-224-ONNX/resolve/ba1f3b0843f24bc5417d38e19c37b287d719b2f4
ADD ${SIGLIP}/onnx/vision_model.onnx /app/models/siglip2_vision.onnx
COPY --from=fahrzeug-text /m/fahrzeug_text.npz /app/models/fahrzeug_text.npz

# Warmup lädt Detektor- und OCR-Modell beim Build ins Image (kein Download
# zur Laufzeit).
COPY districts.py plate.py segment.py fahrzeug.py app.py warmup.py ./
RUN python warmup.py

# CPU wird mit dem Tileserver geteilt – Thread-Zahl der BLAS/OMP-Pools begrenzen.
ENV OMP_NUM_THREADS=2

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
