# Normalisierung roher OCR-Lesungen auf das deutsche Kennzeichenformat
# "F-AB 1234" (+ optional E/H), exakt das Format, das initKennzeichenFormat im
# Frontend erzeugt. Die Aufteilung Kreiskürzel/Erkennungsbuchstaben ist ohne
# Trenner mehrdeutig ("FAB" -> F-AB oder FA-B) und wird über die Liste der
# gültigen Unterscheidungszeichen (districts.py) aufgelöst.
from __future__ import annotations

import re

from districts import DISTRICTS

# Typische OCR-Verwechsler, positionsabhängig repariert: In der Ziffernzone
# werden Buchstaben zu Ziffern gemappt, in der Buchstabenzone umgekehrt.
TO_DIGIT = str.maketrans("OIBSZG", "018526")
TO_LETTER = str.maketrans("018526", "OIBSZG")

LETTER_ZONE = re.compile(r"^[A-ZÄÖÜ]{2,5}$")
# Erkennungsbuchstaben: 1-2 Buchstaben, ohne Umlaute.
MIDDLE = re.compile(r"^[A-Z]{1,2}$")
# Erkennungsnummer: 1-4 Ziffern, ohne führende Null.
DIGIT_ZONE = re.compile(r"^[1-9]\d{0,3}$")


def normalize(raw: str) -> tuple[str, bool]:
    """Liefert (text, normalized). normalized=True nur, wenn die Lesung eindeutig
    auf ein gültiges deutsches Kennzeichen gemappt werden konnte; sonst wird die
    bereinigte Rohlesung zurückgegeben (Aufrufer senkt dann die Konfidenz)."""
    # Die Stempelplakette zwischen den Buchstabengruppen liest die OCR gern als
    # Kleinbuchstaben ("MSeWL 545"); echte Prägeschrift wird groß gelesen. Erst
    # mit Kleinbuchstaben-als-Trenner versuchen (markiert zugleich die sonst
    # mehrdeutige Kürzel-Grenze), dann mit der wörtlichen Lesung.
    literal = raw or ""
    stripped = re.sub(r"[a-zäöü]", " ", literal)
    for candidate in ([stripped] if stripped != literal else []) + [literal]:
        text, ok = _normalize_one(candidate)
        if ok:
            return text, True
    return _normalize_one(literal)[0], False


def _normalize_one(raw: str) -> tuple[str, bool]:
    text = (raw or "").upper()
    segs = [s for s in re.split(r"[^A-ZÄÖÜ0-9]+", text) if s]
    if not segs:
        return "", False

    joined = "".join(segs)
    # Hat die OCR die Lücke nach dem Kreiskürzel erkannt, ist dessen Länge bekannt.
    hint = len(segs[0]) if len(segs) > 1 and re.fullmatch(r"[A-ZÄÖÜ]{1,3}", segs[0]) else None

    variants: list[tuple[str, int | None]] = [(joined, hint)]
    if hint is not None:
        variants.append((joined, None))
    # Blau-weißes EU-Band ("D") kann links in den Crop hineinragen.
    if joined.startswith("D") and len(joined) >= 4:
        variants.append((joined[1:], None))

    # Erst alle Varianten strikt (ohne Zeichen-Reparatur) prüfen, dann erst mit
    # Verwechsler-Mapping — so gewinnt z.B. bei "BOB12" die echte Lesung B-OB 12
    # gegen B-O 812, und "DFAB123" wird zu F-AB 123 statt zu D-FA 8123.
    for repair in (False, True):
        for cand, h in variants:
            result = _parse(cand, h, repair)
            if result:
                return result, True
    return joined, False


def _parse(s: str, district_len_hint: int | None, repair: bool) -> str | None:
    suffix = ""
    core = s
    # E (Elektro) / H (Oldtimer) hinter der Erkennungsnummer.
    if len(core) >= 4 and core[-1] in "EH" and core[-2] in "0123456789OIBSZG":
        suffix = core[-1]
        core = core[:-1]
    if not 3 <= len(core) <= 9:
        return None

    # Längere Ziffernzone zuerst (die Erkennungsnummer steht am Ende).
    for k in range(min(4, len(core) - 2), 0, -1):
        letters, digits = core[:-k], core[-k:]
        if repair:
            # Reparatur darf keine Ziffernzone "erfinden": mindestens eine echte
            # Ziffer muss in der Lesung stehen (sonst würde "XYZ" zu "X-Y 2").
            if not any(c.isdigit() for c in digits):
                continue
            letters, digits = letters.translate(TO_LETTER), digits.translate(TO_DIGIT)
        if not LETTER_ZONE.match(letters) or not DIGIT_ZONE.match(digits):
            continue
        split = _split_letters(letters, district_len_hint)
        if split:
            district, middle = split
            return f"{district}-{middle} {digits}{suffix}"
    return None


def _split_letters(letters: str, hint: int | None) -> tuple[str, str] | None:
    """Buchstabenblock in (Kreiskürzel, Erkennungsbuchstaben) zerlegen."""
    lengths = []
    if hint is not None:
        lengths.append(hint)
    # Kürzestes Kürzel zuerst: Einbuchstaben-Städte (B, M, K, F, ...) stellen die
    # meisten Fahrzeuge; bei doppelt gültigen Splits die wahrscheinlichere Wahl.
    lengths.extend(n for n in (1, 2, 3) if n != hint)
    for n in lengths:
        district, middle = letters[:n], letters[n:]
        if district in DISTRICTS and MIDDLE.match(middle):
            return district, middle
    return None
