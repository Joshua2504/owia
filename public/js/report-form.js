// Zusatzfunktionen für das Anzeige-Formular (/report/new):
//
//   1. Tatort aus dem aktuellen Standort des Geräts übernehmen (Geolocation API).
//   2. Tatort aus den GPS-Daten (EXIF) eines hochgeladenen Fotos übernehmen.
//   3. Live-Vorschau der Bilder mit der Möglichkeit, Bereiche zu schwärzen.
//
// Progressive Enhancement: Ohne JavaScript (oder ohne die optionalen CDN-Libs
// exifr/heic2any) funktioniert der normale Datei-Upload unverändert weiter.
// Wichtig: Geschwärzte Bilder werden im Browser neu gerendert und ersetzen die
// Originaldatei – die ungeschwärzten Pixel verlassen das Gerät nicht.
(function () {
  const MAX_DIM = 2560 // Längste Kante geschwärzter Bilder (Dateigröße/Qualität)
  const MIN_BOX = 6 // Kleinere Markierungen werden ignoriert (versehentliche Klicks)

  // ---------------------------------------------------------------------------
  // Gemeinsame Helfer
  // ---------------------------------------------------------------------------

  async function reverseGeocode(lat, lon) {
    const res = await fetch('/api/geo/reverse?lat=' + lat + '&lon=' + lon, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.result || null
  }

  function setTatort(label) {
    const t = document.querySelector('#tatort')
    if (t && label) {
      t.value = label
      t.dispatchEvent(new Event('change'))
    }
  }

  function isHeic(file) {
    const n = (file.name || '').toLowerCase()
    return /image\/hei[cf]/.test(file.type) || n.endsWith('.heic') || n.endsWith('.heif')
  }

  function baseName(name) {
    return (name || 'bild').replace(/\.[^.]+$/, '')
  }

  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob)
      const img = new Image()
      img.onload = () => {
        URL.revokeObjectURL(url)
        resolve(img)
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        reject(new Error('Bild konnte nicht geladen werden'))
      }
      img.src = url
    })
  }

  // ---------------------------------------------------------------------------
  // 1. Aktueller Standort
  // ---------------------------------------------------------------------------

  function initCurrentLocation() {
    const btn = document.querySelector('#btn-current-location')
    const status = document.querySelector('#geo-status')
    if (!btn || !status) return

    btn.addEventListener('click', () => {
      if (!navigator.geolocation) {
        status.textContent = 'Standort wird von diesem Browser nicht unterstützt.'
        return
      }
      status.textContent = 'Standort wird ermittelt …'
      btn.disabled = true
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const s = await reverseGeocode(pos.coords.latitude, pos.coords.longitude)
            if (s && s.label) {
              setTatort(s.label)
              status.textContent = 'Adresse übernommen – bitte prüfen.'
            } else {
              status.textContent = 'Zu diesem Standort wurde keine Adresse gefunden.'
            }
          } catch (_) {
            status.textContent = 'Adresse konnte nicht ermittelt werden.'
          } finally {
            btn.disabled = false
          }
        },
        (err) => {
          status.textContent =
            err && err.code === 1
              ? 'Standortzugriff wurde abgelehnt.'
              : 'Standort konnte nicht ermittelt werden.'
          btn.disabled = false
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      )
    })
  }

  // ---------------------------------------------------------------------------
  // 2. + 3. Bild-Vorschau, GPS aus Foto und Schwärzen
  // ---------------------------------------------------------------------------

  const items = [] // { file, kind, base, canvas, ctx, redactions, gps, els }

  /** Liefert ein im Browser darstellbares Blob (JPEG/PNG) oder null. */
  async function toRasterBlob(file) {
    if (/^image\/(jpeg|png)$/.test(file.type) || /\.(jpe?g|png)$/i.test(file.name)) {
      return file
    }
    if (isHeic(file) && window.heic2any) {
      try {
        const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 })
        return Array.isArray(out) ? out[0] : out
      } catch (_) {
        return null
      }
    }
    return null
  }

  function redraw(item) {
    const { ctx, base, redactions } = item
    ctx.drawImage(base, 0, 0)
    ctx.fillStyle = '#000'
    for (const r of redactions) ctx.fillRect(r.x, r.y, r.w, r.h)
  }

  function prepareCanvas(item, img) {
    const scale = Math.min(1, MAX_DIM / Math.max(img.width, img.height))
    const w = Math.max(1, Math.round(img.width * scale))
    const h = Math.max(1, Math.round(img.height * scale))

    const base = document.createElement('canvas')
    base.width = w
    base.height = h
    base.getContext('2d').drawImage(img, 0, 0, w, h)

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.className = 'img-redact'

    item.base = base
    item.canvas = canvas
    item.ctx = canvas.getContext('2d')
    item.kind = 'raster'
    redraw(item)
    attachDrawing(item)
  }

  function attachDrawing(item) {
    const canvas = item.canvas
    let drawing = false
    let start = null

    function toCanvasCoords(e) {
      const rect = canvas.getBoundingClientRect()
      return {
        x: ((e.clientX - rect.left) * canvas.width) / rect.width,
        y: ((e.clientY - rect.top) * canvas.height) / rect.height,
      }
    }

    canvas.addEventListener('pointerdown', (e) => {
      drawing = true
      start = toCanvasCoords(e)
      canvas.setPointerCapture(e.pointerId)
    })

    canvas.addEventListener('pointermove', (e) => {
      if (!drawing) return
      const p = toCanvasCoords(e)
      redraw(item)
      item.ctx.save()
      item.ctx.fillStyle = 'rgba(0,0,0,0.55)'
      item.ctx.fillRect(start.x, start.y, p.x - start.x, p.y - start.y)
      item.ctx.restore()
    })

    function finish(e) {
      if (!drawing) return
      drawing = false
      const p = toCanvasCoords(e)
      const x = Math.min(start.x, p.x)
      const y = Math.min(start.y, p.y)
      const w = Math.abs(p.x - start.x)
      const h = Math.abs(p.y - start.y)
      if (w >= MIN_BOX && h >= MIN_BOX) {
        item.redactions.push({ x, y, w, h })
        updateToolbar(item)
      }
      redraw(item)
    }

    canvas.addEventListener('pointerup', finish)
    canvas.addEventListener('pointercancel', finish)
  }

  function updateToolbar(item) {
    if (!item.els) return
    const has = item.redactions.length > 0
    item.els.undo.disabled = !has
    item.els.clear.disabled = !has
    item.els.count.textContent = has
      ? item.redactions.length + ' Bereich(e) geschwärzt'
      : ''
  }

  function buildCard(item) {
    const col = document.createElement('div')
    col.className = 'col-12 col-sm-6'

    const card = document.createElement('div')
    card.className = 'card shadow-sm h-100'
    const body = document.createElement('div')
    body.className = 'card-body p-2'
    card.appendChild(body)
    col.appendChild(card)

    const name = document.createElement('div')
    name.className = 'small text-muted text-truncate mb-1'
    name.textContent = item.file.name || 'Bild'
    body.appendChild(name)

    const stage = document.createElement('div')
    stage.className = 'redact-stage'
    stage.textContent = 'lädt …'
    body.appendChild(stage)

    const count = document.createElement('div')
    count.className = 'small text-muted mt-1'
    body.appendChild(count)

    const toolbar = document.createElement('div')
    toolbar.className = 'd-flex flex-wrap gap-2 mt-2'
    body.appendChild(toolbar)

    const undo = mkBtn('↩︎ Rückgängig', 'btn-outline-secondary')
    undo.disabled = true
    undo.addEventListener('click', () => {
      item.redactions.pop()
      redraw(item)
      updateToolbar(item)
    })

    const clear = mkBtn('Alle entfernen', 'btn-outline-secondary')
    clear.disabled = true
    clear.addEventListener('click', () => {
      item.redactions = []
      redraw(item)
      updateToolbar(item)
    })

    const remove = mkBtn('🗑 Bild entfernen', 'btn-outline-danger')
    remove.addEventListener('click', () => {
      const i = items.indexOf(item)
      if (i >= 0) items.splice(i, 1)
      col.remove()
    })

    const gpsBtn = mkBtn('📍 Standort aus Foto', 'btn-outline-primary')
    gpsBtn.style.display = 'none'
    gpsBtn.addEventListener('click', async () => {
      gpsBtn.disabled = true
      const status = document.querySelector('#geo-status')
      try {
        const s = await reverseGeocode(item.gps.latitude, item.gps.longitude)
        if (s && s.label) {
          setTatort(s.label)
          if (status) status.textContent = 'Adresse aus Foto übernommen – bitte prüfen.'
        } else if (status) {
          status.textContent = 'Zu den Foto-Koordinaten wurde keine Adresse gefunden.'
        }
      } catch (_) {
        if (status) status.textContent = 'Adresse konnte nicht ermittelt werden.'
      } finally {
        gpsBtn.disabled = false
      }
    })

    toolbar.appendChild(gpsBtn)
    toolbar.appendChild(undo)
    toolbar.appendChild(clear)
    toolbar.appendChild(remove)

    item.els = { col, stage, count, undo, clear, gpsBtn }
    return col
  }

  function mkBtn(label, variant) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn btn-sm ' + variant
    b.textContent = label
    return b
  }

  async function addItem(file, container) {
    const item = { file, kind: 'passthrough', redactions: [], gps: null, els: null }
    items.push(item)
    const card = buildCard(item)
    container.appendChild(card)

    // GPS aus EXIF (funktioniert auch für HEIC), unabhängig von der Vorschau.
    if (window.exifr) {
      try {
        const g = await window.exifr.gps(file)
        if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
          item.gps = g
          item.els.gpsBtn.style.display = ''
        }
      } catch (_) {
        /* keine GPS-Daten */
      }
    }

    // Raster-Vorschau + Schwärzen aufbauen.
    try {
      const blob = await toRasterBlob(file)
      if (!blob) {
        item.els.stage.textContent =
          'Vorschau/Schwärzen für dieses Format nicht möglich – das Bild wird unverändert hochgeladen.'
        return
      }
      const img = await loadImage(blob)
      prepareCanvas(item, img)
      item.els.stage.textContent = ''
      item.els.stage.appendChild(item.canvas)
      const hint = document.createElement('div')
      hint.className = 'form-text mt-1'
      hint.textContent = 'Zum Schwärzen mit Maus oder Finger über die Bereiche ziehen.'
      item.els.stage.appendChild(hint)
    } catch (_) {
      item.els.stage.textContent =
        'Vorschau nicht möglich – das Bild wird unverändert hochgeladen.'
    }
  }

  function toBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  }

  async function exportItem(item) {
    if (item.kind === 'raster' && item.redactions.length > 0) {
      const blob = await toBlob(item.canvas)
      if (blob) return new File([blob], baseName(item.file.name) + '.jpg', { type: 'image/jpeg' })
    }
    return item.file // unverändertes Original (inkl. HEIC/Pass-through)
  }

  function initImageEditor() {
    const input = document.querySelector('#bilder-input')
    const container = document.querySelector('#image-editor')
    const form = input && input.closest('form')
    if (!input || !container || !form) return

    input.addEventListener('change', async () => {
      const files = Array.from(input.files || [])
      // Auswahl übernehmen und das native Feld leeren, damit dieselben Dateien
      // nicht zusätzlich roh mitgesendet werden. Vor dem Absenden bauen wir
      // input.files aus unserer Liste neu auf.
      input.value = ''
      for (const file of files) await addItem(file, container)
    })

    form.addEventListener('submit', async (e) => {
      if (!items.length) return // nichts angehängt: normaler Ablauf
      e.preventDefault()
      try {
        const dt = new DataTransfer()
        for (const item of items) {
          const file = await exportItem(item)
          if (file) dt.items.add(file)
        }
        input.files = dt.files
      } catch (err) {
        console.error('Bild-Aufbereitung fehlgeschlagen', err)
        alert('Die Bilder konnten nicht aufbereitet werden. Bitte erneut versuchen.')
        return
      }
      form.submit() // löst dieses submit-Event nicht erneut aus
    })
  }

  document.addEventListener('DOMContentLoaded', () => {
    initCurrentLocation()
    initImageEditor()
  })
})()
