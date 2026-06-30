// Verstoßart-Erkennung über ein selbst-gehostetes Vision-Language-Modell (Ollama).
// Dem Modell werden das Foto und die feste VERSTOSS_ARTEN-Liste vorgegeben; es
// liefert die passende Kategorie + Fahrzeug/Beschreibung als JSON zurück.
import fs from 'fs/promises'
import { VERSTOSS_ARTEN } from '../config/verstoss'

const VLM_URL = (process.env.VLM_URL || 'http://ollama:11434').replace(/\/$/, '')
const VLM_MODEL = process.env.VLM_MODEL || 'qwen2.5vl:3b'

export type ViolationResult = {
  verstossArt: string | null
  marke: string | null
  beschreibung: string | null
}

const SYSTEM_PROMPT = [
  'Du analysierst ein Beweisfoto eines mutmaßlichen Park- oder Halteverstoßes in Deutschland.',
  'Antworte ausschließlich als JSON-Objekt mit genau diesen Schlüsseln:',
  '  "verstoss_art": die am besten passende Kategorie, WORTGLEICH aus der unten stehenden Liste, oder null wenn kein Fahrzeug/Verstoß erkennbar ist.',
  '  "fahrzeug_marke": Marke und Farbe des Fahrzeugs, kurz (z.B. "VW Golf, grau"), oder null.',
  '  "beschreibung": ein bis zwei sachliche Sätze, die den sichtbaren Verstoß beschreiben, oder null.',
  'Erfinde nichts. Wähle verstoss_art nur, wenn du sie auf dem Foto erkennst.',
  '',
  'Zulässige Werte für verstoss_art:',
  ...VERSTOSS_ARTEN.map((a) => `- ${a}`),
].join('\n')

/** Normalisiert die Modellantwort gegen den festen Katalog. */
function matchVerstossArt(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const v = value.trim().toLowerCase()
  const exact = VERSTOSS_ARTEN.find((a) => a.toLowerCase() === v)
  if (exact) return exact
  // Modell hat eine nicht exakt passende Kategorie geliefert -> Sammelkategorie.
  return 'Sonstiges'
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

/** Analysiert das Foto. null bei Misserfolg (Dienst nicht erreichbar o.ä.). */
export async function analyzeViolation(filePath: string): Promise<ViolationResult | null> {
  let base64: string
  try {
    base64 = (await fs.readFile(filePath)).toString('base64')
  } catch {
    return null
  }

  const body = {
    model: VLM_MODEL,
    stream: false,
    format: 'json',
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: 'Analysiere dieses Foto.', images: [base64] },
    ],
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90000)
    const res = await fetch(`${VLM_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timeout)

    if (!res.ok) return null
    const data = (await res.json()) as { message?: { content?: string } }
    const content = data.message?.content
    if (!content) return null

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(content)
    } catch {
      return null
    }

    return {
      verstossArt: matchVerstossArt(parsed.verstoss_art),
      marke: asText(parsed.fahrzeug_marke),
      beschreibung: asText(parsed.beschreibung),
    }
  } catch {
    return null
  }
}
