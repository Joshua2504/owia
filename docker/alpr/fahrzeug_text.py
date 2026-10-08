# Build-Schritt (nur im Builder-Stage des Dockerfiles): rechnet die Text-
# Embeddings der Marken- und Farb-Beschreibungen aus fahrzeug_prompts.json mit
# dem SigLIP2-Textmodell vor. Das Laufzeit-Image braucht danach nur noch das
# Bildmodell und diese kleine .npz – kein Textmodell, kein Tokenizer.
#
# Aufruf: python fahrzeug_text.py <modelldir> <prompts.json> <out.npz>
import json
import sys

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

mdir, prompts, out = sys.argv[1:4]
tok = Tokenizer.from_file(f"{mdir}/tokenizer.json")
txt = ort.InferenceSession(f"{mdir}/text_model.onnx", providers=["CPUExecutionProvider"])


def embed(text: str) -> np.ndarray:
    # SigLIP2 ist auf kleingeschriebenen, auf 64 Token aufgefüllten Text trainiert.
    ids = tok.encode(text.lower()).ids[:64]
    e = txt.run(None, {"input_ids": np.array([ids + [0] * (64 - len(ids))], np.int64)})[-1][0]
    return e / np.linalg.norm(e)


res = {}
for group, spec in json.load(open(prompts, encoding="utf-8")).items():
    names, vecs = [], []
    for label, words in spec["labels"].items():
        # Prompt-Ensemble: Mittelwert über alle Vorlagen × Schreibweisen.
        m = np.mean([embed(t.format(w)) for w in words for t in spec["vorlagen"]], axis=0)
        names.append(label)
        vecs.append(m / np.linalg.norm(m))
    res[f"{group}_names"] = np.array(names)
    res[group] = np.array(vecs, np.float32)
np.savez(out, **res)
print("Text-Embeddings:", {k: v.shape for k, v in res.items()})
