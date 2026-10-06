# Lage der Plakettenlücke im Kennzeichen-Crop -> Länge des Kreiskürzels.
#
# Das Kennzeichen-OCR liefert nur die Zeichenfolge ("SUO5000"), ohne Trenner.
# Die Aufteilung in Kreiskürzel/Erkennungsbuchstaben ist damit oft mehrdeutig
# (S-UO oder SU-O). Auf dem Schild selbst ist sie eindeutig: zwischen beiden
# Gruppen sitzen die Plaketten und lassen eine deutlich breitere Lücke als
# zwischen normalen Zeichen. Die wird hier über die Zeichen-Komponenten der
# binarisierten Schrift gesucht. Liefert im Zweifel None (dann entscheidet die
# Kürzel-Liste in plate.py allein).
from __future__ import annotations

import cv2
import numpy as np


def _char_boxes(crop: np.ndarray) -> list[tuple[int, int]]:
    """Horizontale Ausdehnung (x1, x2) der Schriftzeichen, links nach rechts."""
    if crop.shape[0] < 8 or crop.shape[1] < 8:
        return []
    scale = 100 / crop.shape[0]
    img = cv2.resize(crop, (max(1, int(crop.shape[1] * scale)), 100), interpolation=cv2.INTER_CUBIC)
    b, g, r = (c.astype(int) for c in cv2.split(img))
    blue = (b > r + 30) & (b > g + 10)  # EU-Band ausblenden
    gray = cv2.createCLAHE(2.0, (4, 4)).apply(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    bw[blue] = 0

    n, _, stats, _ = cv2.connectedComponentsWithStats(bw, 8)
    h_img, w_img = bw.shape
    comps = [
        tuple(int(v) for v in stats[i][:4])
        for i in range(1, n)
        if 0.3 * h_img <= stats[i][3] <= 0.95 * h_img and 2 <= stats[i][2] <= 0.3 * w_img
    ]
    if not comps:
        return []
    # Schriftzeichen sind gleich hoch; Plaketten, Rahmen, Händlerzeile nicht.
    mh = float(np.median([c[3] for c in comps]))
    comps = [c for c in comps if 0.75 * mh <= c[3] <= 1.3 * mh]
    if len(comps) < 3:
        return []
    # Gemeinsame Schriftzeile (Gerade, damit schräge Aufnahmen nicht stören).
    xs = np.array([c[0] + c[2] / 2 for c in comps])
    ys = np.array([c[1] + c[3] / 2 for c in comps])
    k, m = np.polyfit(xs, ys, 1)
    comps = sorted(c for c, x, y in zip(comps, xs, ys) if abs(y - (k * x + m)) < 0.3 * mh)

    boxes: list[tuple[int, int]] = []
    for x, _, w, _ in comps:
        if boxes and x < boxes[-1][1] - 1:  # zerbrochenes Zeichen zusammenfassen
            boxes[-1] = (boxes[-1][0], max(boxes[-1][1], x + w))
        else:
            boxes.append((x, x + w))
    return boxes


def district_length(crop: np.ndarray, text: str) -> int | None:
    """Anzahl Zeichen vor der Plakettenlücke (1-3) oder None, wenn unklar.
    crop sollte etwas Rand haben, damit keine Zeichen angeschnitten sind."""
    letters = len(text) - len(text.lstrip("ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÜ"))
    if letters < 2:
        return None
    boxes = _char_boxes(crop)
    if len(boxes) < 3:
        return None
    gaps = [boxes[i + 1][0] - boxes[i][1] for i in range(len(boxes) - 1)]
    order = np.argsort(gaps)[::-1]
    widest = int(order[0])
    second = gaps[int(order[1])] if len(gaps) > 1 else 0
    char_w = float(np.median([b[1] - b[0] for b in boxes]))
    # Die Plakettenlücke ist breit und klar breiter als jede andere Lücke
    # (auch als die zwischen Buchstaben und Ziffern).
    if gaps[widest] < 0.6 * char_w or gaps[widest] < 1.3 * max(second, 1):
        return None
    n = widest + 1
    return n if 1 <= n <= min(3, letters - 1) else None
