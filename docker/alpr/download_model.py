# Lädt das YOLO-Kennzeichenmodell beim Docker-Build von Hugging Face und legt es
# unter models/ ab — zur Laufzeit ist kein externer Netzwerkzugriff nötig.
# Revision gepinnt, damit Builds reproduzierbar sind.
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download

REPO_ID = "morsetechlab/yolov11-license-plate-detection"  # AGPL-3.0
FILENAME = "license-plate-finetune-v1s.onnx"
REVISION = "251a30d7daedca065f56e04b0af04052c907c68f"

target = Path("models") / FILENAME
target.parent.mkdir(exist_ok=True)
cached = hf_hub_download(repo_id=REPO_ID, filename=FILENAME, revision=REVISION)
shutil.copy(cached, target)
print(f"YOLO-Modell gespeichert: {target} ({target.stat().st_size / 1e6:.1f} MB)")
