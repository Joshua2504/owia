// Zusatzfunktionen für das Entwurfs-Formular (/report/:id/edit):
//
//   1. Tatort aus dem aktuellen Standort des Geräts übernehmen (Geolocation API).
//   2. Tatort aus den GPS-Daten (EXIF) eines hochgeladenen Fotos übernehmen.
//   3. Live-Vorschau der Bilder mit der Möglichkeit, Bereiche zu schwärzen, und
//      Sofort-Upload (geschwärzte Fassung) in den Entwurf.
//   4. Hintergrund-Autosave der Textfelder.
//
// Progressive Enhancement: Ohne die optionalen CDN-Libs (exifr/heic2any) bleiben
// GPS- und HEIC-Vorschau einfach aus. Wichtig: Geschwärzte Bilder werden im
// Browser neu gerendert; nur die geschwärzte Fassung verlässt das Gerät.
(function () {
  const MAX_DIM = 2560 // Längste Kante geschwärzter Bilder
  const MIN_BOX = 6 // Kleinere Markierungen werden ignoriert
  const SAVE_DEBOUNCE_MS = 800

  let reportId = null

  function debounce(fn, ms) {
    let t
    return function () {
      const args = arguments
      clearTimeout(t)
      t = setTimeout(() => fn.apply(this, args), ms)
    }
  }

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
      t.dispatchEvent(new Event('input'))
      t.dispatchEvent(new Event('change'))
    }
  }

  // Koordinaten an die Tatort-Karte melden (report-map.js setzt den Marker und
  // schreibt die Hidden-Felder tatort_lat/tatort_lon).
  function announceLocation(lat, lon, label) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return
    document.dispatchEvent(
      new CustomEvent('address:selected', { detail: { lat: lat, lon: lon, label: label } })
    )
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

  function mkBtn(label, variant) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn btn-sm ' + variant
    b.textContent = label
    return b
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
              announceLocation(pos.coords.latitude, pos.coords.longitude, s.label)
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
  // 2. + 3. Bild-Vorschau, GPS aus Foto, Schwärzen und Upload
  // ---------------------------------------------------------------------------

  const items = [] // { file, kind, base, canvas, ctx, redactions, gps, els }

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
        item.saveDebounced()
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
    item.els.count.textContent = has ? item.redactions.length + ' Bereich(e) geschwärzt' : ''
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
    name.textContent = (item.file && item.file.name) || 'Bild'
    body.appendChild(name)

    const stage = document.createElement('div')
    stage.className = 'redact-stage'
    stage.textContent = 'lädt …'
    body.appendChild(stage)

    const count = document.createElement('div')
    count.className = 'small text-muted mt-1'
    body.appendChild(count)

    const status = document.createElement('div')
    status.className = 'small text-muted mt-1'
    body.appendChild(status)

    const toolbar = document.createElement('div')
    toolbar.className = 'd-flex flex-wrap gap-2 mt-2'
    body.appendChild(toolbar)

    const undo = mkBtn('↩︎ Rückgängig', 'btn-outline-secondary')
    undo.disabled = true
    undo.addEventListener('click', () => {
      item.redactions.pop()
      redraw(item)
      updateToolbar(item)
      item.saveDebounced()
    })

    const clear = mkBtn('Alle entfernen', 'btn-outline-secondary')
    clear.disabled = true
    clear.addEventListener('click', () => {
      item.redactions = []
      redraw(item)
      updateToolbar(item)
      item.saveDebounced()
    })

    const remove = mkBtn('🗑 Entfernen', 'btn-outline-danger')
    remove.addEventListener('click', () => removeItem(item))

    const gpsBtn = mkBtn('📍 Standort aus Foto', 'btn-outline-primary')
    gpsBtn.style.display = 'none'
    gpsBtn.addEventListener('click', async () => {
      gpsBtn.disabled = true
      const status = document.querySelector('#geo-status')
      try {
        const s = await reverseGeocode(item.gps.latitude, item.gps.longitude)
        if (s && s.label) {
          setTatort(s.label)
          announceLocation(item.gps.latitude, item.gps.longitude, s.label)
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

    item.els = { col, stage, count, status, undo, clear, gpsBtn }
    return col
  }

  function newItem(file, serverImageId) {
    const item = {
      file,
      kind: 'passthrough',
      redactions: [],
      gps: null,
      els: null,
      serverImageId: serverImageId || null, // ID der gespeicherten Fassung im Entwurf
      saving: false,
      dirty: false,
    }
    item.saveDebounced = debounce(() => saveItem(item), SAVE_DEBOUNCE_MS)
    return item
  }

  // GPS aus dem Foto lesen und die Schwärzungs-Leinwand aufbauen.
  async function renderItemMedia(item) {
    if (window.exifr) {
      try {
        const g = await window.exifr.gps(item.file)
        if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) {
          item.gps = g
          item.els.gpsBtn.style.display = ''
        }
      } catch (_) {
        /* keine GPS-Daten */
      }
    }

    try {
      const blob = await toRasterBlob(item.file)
      if (!blob) {
        item.els.stage.textContent =
          'Vorschau/Schwärzen für dieses Format nicht möglich – das Bild bleibt unverändert.'
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
      item.els.stage.textContent = 'Vorschau nicht möglich – das Bild bleibt unverändert.'
    }
  }

  // Neu ausgewähltes Bild: Karte anlegen, sofort zum Entwurf hochladen.
  async function addItem(file, container) {
    const item = newItem(file, null)
    items.push(item)
    container.appendChild(buildCard(item))
    saveItem(item) // sofort hinzufügen; Schwärzungen werden danach automatisch gespeichert
    await renderItemMedia(item)
  }

  // Bereits gespeichertes Bild (nach Neuladen) als bearbeitbare Karte laden.
  async function addExistingItem(image, container) {
    const item = newItem(null, image.id)
    items.push(item)
    container.appendChild(buildCard(item))
    item.els.stage.textContent = 'lädt …'

    let blob
    try {
      const res = await fetch(image.url)
      if (!res.ok) throw new Error('load failed')
      blob = await res.blob()
    } catch (_) {
      // Datei nicht ladbar – Karte bleibt (zum Entfernen), aber ohne Bearbeitung.
      item.els.stage.textContent = 'Bild konnte nicht geladen werden.'
      setItemStatus(item, 'Gespeichert ✓')
      return
    }

    const type = blob.type || 'image/jpeg'
    const ext = type.indexOf('png') >= 0 ? 'png' : 'jpg'
    item.file = new File([blob], 'bild-' + image.id + '.' + ext, { type })
    setItemStatus(item, 'Gespeichert ✓') // bereits im Entwurf, nichts hochzuladen
    await renderItemMedia(item)
  }

  function toBlob(canvas) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
  }

  async function exportItem(item) {
    if (item.kind === 'raster' && item.redactions.length > 0) {
      const blob = await toBlob(item.canvas)
      if (blob) return new File([blob], baseName(item.file.name) + '.jpg', { type: 'image/jpeg' })
    }
    return item.file
  }

  function setItemStatus(item, text, isError) {
    if (!item.els || !item.els.status) return
    item.els.status.textContent = text
    item.els.status.className = 'small mt-1 ' + (isError ? 'text-danger' : 'text-muted')
  }

  // Aktuellen Stand des Bildes (ggf. mit Schwärzungen) zum Entwurf speichern.
  // Erste Speicherung legt das Bild an (POST); spätere ersetzen die Fassung in
  // place (PUT) – so bleibt die Bild-ID stabil und das Limit wird nicht berührt.
  async function saveItem(item) {
    if (item.removed) return
    if (item.saving) {
      item.dirty = true // während des Speicherns kam eine weitere Änderung
      return
    }
    item.saving = true
    setItemStatus(item, 'Speichert …')
    try {
      const file = await exportItem(item)
      const fd = new FormData()
      fd.append('bilder', file, file.name)

      let savedId
      if (item.serverImageId) {
        const res = await fetch('/report/' + reportId + '/images/' + item.serverImageId, {
          method: 'PUT',
          body: fd,
        })
        if (!res.ok) throw new Error('replace failed')
        const data = await res.json()
        savedId = data.image && data.image.id
      } else {
        const res = await fetch('/report/' + reportId + '/images', { method: 'POST', body: fd })
        if (!res.ok) throw new Error('upload failed')
        const data = await res.json()
        if (data.errors && data.errors.length) alert(data.errors[0])
        const newImg = (data.images || [])[0]
        savedId = newImg && newImg.id
      }
      if (!savedId) throw new Error('not saved')
      item.serverImageId = savedId
      setItemStatus(item, 'Gespeichert ✓')
    } catch (_) {
      setItemStatus(item, 'Nicht gespeichert – erneut versuchen.', true)
    } finally {
      item.saving = false
      if (item.dirty && !item.removed) {
        item.dirty = false
        saveItem(item)
      }
    }
  }

  // Bild aus dem Entwurf entfernen (Karte + serverseitig gespeicherte Fassung).
  async function removeItem(item) {
    if (!confirm('Bild aus dem Entwurf entfernen?')) return
    item.removed = true
    const i = items.indexOf(item)
    if (i >= 0) items.splice(i, 1)
    if (item.els && item.els.col) item.els.col.remove()
    if (item.serverImageId) {
      fetch('/report/' + reportId + '/images/' + item.serverImageId, { method: 'DELETE' }).catch(
        () => {}
      )
    }
  }

  function initImageEditor() {
    const input = document.querySelector('#bilder-input')
    const container = document.querySelector('#image-editor')
    if (!input || !container) return

    input.addEventListener('change', async () => {
      const files = Array.from(input.files || [])
      input.value = ''
      for (const file of files) await addItem(file, container)
    })

    // Bereits gespeicherte Bilder (nach Neuladen) als bearbeitbare Karten laden,
    // damit sie weiter geschwärzt werden können – nicht nur löschbar.
    const dataEl = document.querySelector('#existing-images-data')
    if (dataEl) {
      let existing = []
      try {
        existing = JSON.parse(dataEl.textContent || '[]')
      } catch (_) {
        existing = []
      }
      existing.forEach((image) => addExistingItem(image, container))
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Autosave der Textfelder
  // ---------------------------------------------------------------------------

  const SAVE_FIELDS = [
    'kennzeichen',
    'fahrzeug_marke',
    'tattag',
    'tatzeit_von',
    'tatzeit_bis',
    'tatort',
    'tatort_lat',
    'tatort_lon',
    'verstoss_art',
    'beschreibung',
    'behinderung',
    'behinderung_text',
  ]

  function initAutosave(form) {
    const status = document.querySelector('#save-status')

    const save = debounce(async () => {
      const body = {}
      SAVE_FIELDS.forEach((n) => {
        const el = form.elements[n]
        if (el) body[n] = el.value
      })
      if (status) status.textContent = 'Speichert …'
      try {
        const res = await fetch('/report/' + reportId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (status) status.textContent = res.ok ? 'Gespeichert ✓' : 'Nicht gespeichert'
      } catch (_) {
        if (status) status.textContent = 'Nicht gespeichert'
      }
    }, SAVE_DEBOUNCE_MS)

    SAVE_FIELDS.forEach((n) => {
      const el = form.elements[n]
      if (!el) return
      // Radio-Gruppen (z.B. behinderung) liefern eine RadioNodeList ohne
      // addEventListener – dann an jedem einzelnen Radio lauschen.
      const nodes = typeof el.addEventListener === 'function' ? [el] : Array.from(el)
      nodes.forEach((node) => {
        node.addEventListener('input', save)
        node.addEventListener('change', save)
      })
    })
  }

  // „Wer wurde wie behindert?" nur einblenden, wenn „Ja" gewählt ist.
  function initBehinderung(form) {
    const detail = document.querySelector('#behinderung-detail')
    if (!detail) return
    const radios = form.elements['behinderung']
    if (!radios) return
    const nodes = typeof radios.addEventListener === 'function' ? [radios] : Array.from(radios)
    const update = () => {
      detail.classList.toggle('d-none', form.elements['behinderung'].value !== 'ja')
    }
    nodes.forEach((node) => node.addEventListener('change', update))
    update()
  }

  document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('#report-form[data-report-id]')
    if (!form) return
    reportId = form.dataset.reportId

    initCurrentLocation()
    initImageEditor()
    initAutosave(form)
    initBehinderung(form)
  })
})()
