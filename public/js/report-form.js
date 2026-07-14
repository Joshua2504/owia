// Zusatzfunktionen für das Entwurfs-Formular (/report/:id/edit):
//
//   1. Tatort aus dem aktuellen Standort des Geräts übernehmen (Geolocation API).
//   2. Tatort aus den GPS-Daten (EXIF) eines hochgeladenen Fotos übernehmen.
//   3. Uhrzeit von/bis aus den EXIF-Aufnahmezeiten der Fotos übernehmen
//      (von = frühestes, bis = spätestes Foto).
//   4. Live-Vorschau der Bilder mit der Möglichkeit, Bereiche zu schwärzen, und
//      Sofort-Upload (geschwärzte Fassung) in den Entwurf.
//   5. Hintergrund-Autosave der Textfelder.
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

  // Bereich als grobe Mosaik-Blöcke unkenntlich machen (stärker als ein weicher
  // Blur – Kennzeichen/Gesichter bleiben auch vergrößert unlesbar).
  function drawPixelated(ctx, base, r) {
    const block = 14
    const tw = Math.max(1, Math.round(r.w / block))
    const th = Math.max(1, Math.round(r.h / block))
    const tmp = document.createElement('canvas')
    tmp.width = tw
    tmp.height = th
    tmp.getContext('2d').drawImage(base, r.x, r.y, r.w, r.h, 0, 0, tw, th)
    ctx.save()
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(tmp, 0, 0, tw, th, r.x, r.y, r.w, r.h)
    ctx.restore()
  }

  function redraw(item) {
    const { ctx, base, redactions } = item
    ctx.drawImage(base, 0, 0)
    for (const r of redactions) {
      if (r.type === 'pixel') {
        drawPixelated(ctx, base, r)
      } else {
        ctx.fillStyle = '#000'
        ctx.fillRect(r.x, r.y, r.w, r.h)
      }
    }
  }

  // Bild um 90° im Uhrzeigersinn drehen; vorhandene Markierungen drehen mit.
  function rotateItem(item) {
    if (!item.base) return
    const old = item.base
    const rotated = document.createElement('canvas')
    rotated.width = old.height
    rotated.height = old.width
    const rctx = rotated.getContext('2d')
    rctx.translate(rotated.width, 0)
    rctx.rotate(Math.PI / 2)
    rctx.drawImage(old, 0, 0)

    item.redactions = item.redactions.map((r) => ({
      x: old.height - (r.y + r.h),
      y: r.x,
      w: r.h,
      h: r.w,
      type: r.type,
    }))

    item.base = rotated
    item.canvas.width = rotated.width
    item.canvas.height = rotated.height
    item.edited = true
    redraw(item)
    updateToolbar(item)
    item.saveDebounced()
  }

  // Bild auf den markierten Bereich zuschneiden; Markierungen wandern mit,
  // vollständig außerhalb liegende entfallen.
  function applyCrop(item, rect) {
    const old = item.base
    const x = Math.max(0, Math.round(rect.x))
    const y = Math.max(0, Math.round(rect.y))
    const w = Math.min(old.width - x, Math.round(rect.w))
    const h = Math.min(old.height - y, Math.round(rect.h))
    if (w < 1 || h < 1) return

    const cropped = document.createElement('canvas')
    cropped.width = w
    cropped.height = h
    cropped.getContext('2d').drawImage(old, x, y, w, h, 0, 0, w, h)

    item.redactions = item.redactions
      .map((r) => {
        const nx = Math.max(0, r.x - x)
        const ny = Math.max(0, r.y - y)
        const nw = Math.min(r.x + r.w - x, w) - nx
        const nh = Math.min(r.y + r.h - y, h) - ny
        return { x: nx, y: ny, w: nw, h: nh, type: r.type }
      })
      .filter((r) => r.w >= MIN_BOX && r.h >= MIN_BOX)

    item.base = cropped
    item.canvas.width = w
    item.canvas.height = h
    item.edited = true
    setTool(item, 'black') // nach dem Zuschnitt zurück zum Standard-Werkzeug
    redraw(item)
    updateToolbar(item)
    item.saveDebounced()
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
      if (item.tool === 'crop') {
        // Zuschnitt-Vorschau: gestrichelter Rahmen statt Füllung.
        item.ctx.strokeStyle = '#0d6efd'
        item.ctx.lineWidth = Math.max(2, canvas.width / 300)
        item.ctx.setLineDash([8, 6])
        item.ctx.strokeRect(start.x, start.y, p.x - start.x, p.y - start.y)
      } else {
        item.ctx.fillStyle = 'rgba(0,0,0,0.55)'
        item.ctx.fillRect(start.x, start.y, p.x - start.x, p.y - start.y)
      }
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
      if (item.tool === 'crop') {
        // Mindestgröße, damit ein versehentlicher Klick nicht alles wegschneidet.
        if (w >= 40 && h >= 40 && confirm('Bild auf den markierten Bereich zuschneiden?')) {
          applyCrop(item, { x, y, w, h })
          return
        }
      } else if (w >= MIN_BOX && h >= MIN_BOX) {
        item.redactions.push({ x, y, w, h, type: item.tool === 'pixel' ? 'pixel' : 'black' })
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
    if (item.tool === 'crop') {
      item.els.count.textContent = 'Bereich zum Zuschneiden aufziehen'
    } else {
      item.els.count.textContent = has
        ? item.redactions.length + ' Bereich(e) unkenntlich gemacht'
        : ''
    }
  }

  // Aktives Zeichen-Werkzeug der Karte umschalten (Schwärzen/Verpixeln/Zuschneiden).
  function setTool(item, tool) {
    item.tool = tool
    if (item.els && item.els.toolBtns) {
      Object.keys(item.els.toolBtns).forEach((key) => {
        item.els.toolBtns[key].classList.toggle('btn-secondary', key === tool)
        item.els.toolBtns[key].classList.toggle('btn-outline-secondary', key !== tool)
      })
    }
    updateToolbar(item)
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

    // Werkzeuge: Schwärzen (Standard), Verpixeln, Zuschneiden + Drehen-Aktion.
    const toolBlack = mkBtn('⬛ Schwärzen', 'btn-secondary')
    toolBlack.title = 'Bereiche schwarz übermalen'
    toolBlack.addEventListener('click', () => setTool(item, 'black'))
    const toolPixel = mkBtn('▩ Verpixeln', 'btn-outline-secondary')
    toolPixel.title = 'Bereiche verpixeln (z.B. Gesichter, fremde Kennzeichen)'
    toolPixel.addEventListener('click', () => setTool(item, 'pixel'))
    const toolCrop = mkBtn('✂️ Zuschneiden', 'btn-outline-secondary')
    toolCrop.title = 'Bild auf einen Ausschnitt zuschneiden'
    toolCrop.addEventListener('click', () => setTool(item, item.tool === 'crop' ? 'black' : 'crop'))
    const rotate = mkBtn('⟳ Drehen', 'btn-outline-secondary')
    rotate.title = 'Um 90° im Uhrzeigersinn drehen'
    rotate.addEventListener('click', () => rotateItem(item))

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

    const gpsBtn = mkBtn('📍 Standort & Zeit aus Foto', 'btn-outline-primary')
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

        // Zeitspanne (von = frühestes, bis = spätestes Foto) ebenfalls übernehmen.
        const range = getPhotoTimeRange()
        if (range) {
          applyPhotoTimes()
          const tStatus = document.querySelector('#photo-time-status')
          if (tStatus) {
            const von = toHHMM(range.min)
            const bis = toHHMM(range.max)
            const span = bis !== von ? von + ' – ' + bis : von
            tStatus.textContent = 'Uhrzeit aus Fotos übernommen (' + span + ') – bitte prüfen.'
          }
        }
      } catch (_) {
        if (status) status.textContent = 'Adresse konnte nicht ermittelt werden.'
      } finally {
        gpsBtn.disabled = false
      }
    })

    // Reihenfolge ändern: ◀ weiter nach vorne, ▶ weiter nach hinten. Das erste Bild
    // dient u.a. als Karten-Marker.
    const moveLeft = mkBtn('◀', 'btn-outline-secondary')
    moveLeft.title = 'Weiter nach vorne'
    moveLeft.addEventListener('click', () => moveItem(item, -1))
    const moveRight = mkBtn('▶', 'btn-outline-secondary')
    moveRight.title = 'Weiter nach hinten'
    moveRight.addEventListener('click', () => moveItem(item, 1))

    toolbar.appendChild(toolBlack)
    toolbar.appendChild(toolPixel)
    toolbar.appendChild(toolCrop)
    toolbar.appendChild(rotate)
    toolbar.appendChild(moveLeft)
    toolbar.appendChild(moveRight)
    toolbar.appendChild(gpsBtn)
    toolbar.appendChild(undo)
    toolbar.appendChild(clear)
    toolbar.appendChild(remove)

    // Foto in einen anderen offenen Entwurf oder eine neue Anzeige verschieben.
    var moveSel = document.createElement('select')
    moveSel.className = 'form-select form-select-sm w-auto'
    moveSel.title = 'Foto in eine andere Anzeige verschieben'
    var placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = '↪ Verschieben in …'
    moveSel.appendChild(placeholder)
    ;(window.OTHER_DRAFTS || []).forEach(function (d) {
      var opt = document.createElement('option')
      opt.value = d.az
      opt.textContent = d.label
      moveSel.appendChild(opt)
    })
    var newOpt = document.createElement('option')
    newOpt.value = '__new__'
    newOpt.textContent = '➕ Neue Anzeige'
    moveSel.appendChild(newOpt)
    // Erst nutzbar, sobald das Bild serverseitig gespeichert ist (bestehende
    // Bilder haben die ID schon beim Aufbau der Karte).
    moveSel.disabled = !item.serverImageId
    moveSel.addEventListener('change', function () { moveItemToReport(item, moveSel) })
    toolbar.appendChild(moveSel)

    item.els = {
      col, stage, count, status, undo, clear, gpsBtn, moveLeft, moveRight, moveSel,
      toolBtns: { black: toolBlack, pixel: toolPixel, crop: toolCrop },
    }
    return col
  }

  // Foto (gespeicherte Fassung) in einen anderen Entwurf oder eine neue Anzeige verschieben.
  async function moveItemToReport(item, sel) {
    const targetAz = sel.value
    if (!targetAz || !item.serverImageId) {
      sel.value = ''
      return
    }
    const isNew = targetAz === '__new__'
    const label = sel.options[sel.selectedIndex].textContent
    const question = isNew
      ? 'Foto in eine neue Anzeige verschieben?'
      : 'Foto in die Anzeige „' + label + '" verschieben?'
    if (!confirm(question)) {
      sel.value = ''
      return
    }
    sel.disabled = true
    try {
      const res = await fetch('/report/' + reportId + '/images/' + item.serverImageId + '/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(isNew ? { newDraft: true } : { targetAz: targetAz }),
      })
      const data = await res.json().catch(function () { return {} })
      if (!res.ok) {
        alert(data.error || 'Verschieben fehlgeschlagen.')
        sel.value = ''
        sel.disabled = false
        return
      }
      // Karte entfernen wie beim Löschen, aber ohne Lösch-Request.
      item.removed = true
      const i = items.indexOf(item)
      if (i >= 0) items.splice(i, 1)
      if (item.els && item.els.col) item.els.col.remove()
      if (item.takenAt) refreshPhotoTimes(false)
      updateMoveButtons()
      announceFirstImage()
    } catch (_) {
      alert('Verschieben fehlgeschlagen.')
      sel.value = ''
      sel.disabled = false
    }
  }

  function newItem(file, serverImageId) {
    const item = {
      file,
      kind: 'passthrough',
      redactions: [],
      tool: 'black', // aktives Zeichen-Werkzeug: black | pixel | crop
      edited: false, // true nach Drehen/Zuschneiden (auch ohne Markierungen speichern)
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

      // Aufnahmezeit (EXIF) lesen – speist die Uhrzeit von/bis aus den Fotos.
      try {
        const meta = await window.exifr.parse(item.file, [
          'DateTimeOriginal',
          'CreateDate',
          'ModifyDate',
        ])
        const dt = meta && (meta.DateTimeOriginal || meta.CreateDate || meta.ModifyDate)
        if (dt instanceof Date && !isNaN(dt.getTime())) {
          item.takenAt = dt
          // Frisch hochgeladene Fotos dürfen die (noch unberührten) Zeitfelder füllen;
          // beim Nachladen bestehender Entwürfe nur den Button anbieten.
          refreshPhotoTimes(!item.isExisting)
        }
      } catch (_) {
        /* keine Zeit-Metadaten */
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
    updateMoveButtons()
    saveItem(item) // sofort hinzufügen; Schwärzungen werden danach automatisch gespeichert
    await renderItemMedia(item)
  }

  // Bereits gespeichertes Bild (nach Neuladen) als bearbeitbare Karte laden.
  async function addExistingItem(image, container) {
    const item = newItem(null, image.id)
    item.isExisting = true // bereits gespeicherter Entwurf: Zeiten nicht automatisch überschreiben
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
    // Bearbeitet = Schwärzungen/Verpixelungen ODER Drehen/Zuschneiden angewandt.
    if (item.kind === 'raster' && (item.redactions.length > 0 || item.edited)) {
      redraw(item) // sicherstellen, dass keine Zeichen-Vorschau im Export landet
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
      // Bild ist gespeichert -> es kann in eine andere Anzeige verschoben werden.
      if (item.els && item.els.moveSel) item.els.moveSel.disabled = false
      updateMoveButtons()
      announceFirstImage() // neu gespeichertes (erstes) Bild -> Karten-Marker aktualisieren
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
    if (item.takenAt) refreshPhotoTimes(false) // Zeitspanne ohne dieses Foto neu anzeigen
    if (item.serverImageId) {
      fetch('/report/' + reportId + '/images/' + item.serverImageId, { method: 'DELETE' }).catch(
        () => {}
      )
    }
    updateMoveButtons()
    announceFirstImage() // erstes Bild könnte sich geändert haben -> Karten-Marker aktualisieren
  }

  // ---------------------------------------------------------------------------
  // Bildreihenfolge (◀ ▶) – das erste Bild dient u.a. als Karten-Marker.
  // ---------------------------------------------------------------------------

  function orderedCols() {
    const container = document.querySelector('#image-editor')
    return container ? Array.from(container.children) : []
  }

  // Server-Bild-IDs in aktueller DOM-Reihenfolge (nur bereits gespeicherte Bilder).
  function currentOrderIds() {
    return orderedCols()
      .map((col) => {
        const it = items.find((x) => x.els && x.els.col === col)
        return it && it.serverImageId
      })
      .filter(Boolean)
  }

  // Erstes Bild an die Tatort-Karte melden (report-map.js aktualisiert den Marker).
  function announceFirstImage() {
    const first = currentOrderIds()[0]
    document.dispatchEvent(
      new CustomEvent('report:first-image', {
        detail: { url: first ? '/report/' + reportId + '/image/' + first + '/thumb.jpg' : null },
      })
    )
  }

  function persistImageOrder() {
    const order = currentOrderIds()
    announceFirstImage()
    if (order.length < 2) return
    fetch('/report/' + reportId + '/images/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: order }),
    }).catch(() => {})
  }

  function updateMoveButtons() {
    const cols = orderedCols()
    cols.forEach((col, i) => {
      const it = items.find((x) => x.els && x.els.col === col)
      if (!it || !it.els) return
      if (it.els.moveLeft) it.els.moveLeft.disabled = i === 0
      if (it.els.moveRight) it.els.moveRight.disabled = i === cols.length - 1
    })
  }

  function moveItem(item, dir) {
    const container = document.querySelector('#image-editor')
    const col = item.els && item.els.col
    if (!container || !col) return
    if (dir < 0 && col.previousElementSibling) {
      container.insertBefore(col, col.previousElementSibling)
    } else if (dir > 0 && col.nextElementSibling) {
      container.insertBefore(col.nextElementSibling, col)
    } else {
      return
    }
    updateMoveButtons()
    persistImageOrder()
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
      updateMoveButtons()
    }
  }

  // ---------------------------------------------------------------------------
  // Uhrzeit (von–bis) aus den EXIF-Aufnahmezeiten der Fotos übernehmen
  // ---------------------------------------------------------------------------

  // Wird true, sobald der Nutzer eines der Zeitfelder selbst anfasst – danach
  // wird nicht mehr automatisch aus den Fotos befüllt (nur noch per Button).
  let userEditedTimes = false

  function pad2(n) {
    return String(n).padStart(2, '0')
  }
  function toHHMM(d) {
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  }
  function toDateValue(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  }

  // Wert setzen und Autosave/Behörden-Logik wie bei echter Eingabe auslösen.
  function setFieldValue(el, value) {
    if (!el || !value) return
    el.value = value
    el.dispatchEvent(new Event('input'))
    el.dispatchEvent(new Event('change'))
  }

  // Früheste/späteste Aufnahmezeit über alle Fotos mit Zeit-Metadaten.
  function getPhotoTimeRange() {
    let min = null
    let max = null
    for (const it of items) {
      const d = it.takenAt
      if (!(d instanceof Date) || isNaN(d.getTime())) continue
      if (!min || d < min) min = d
      if (!max || d > max) max = d
    }
    return min ? { min: min, max: max } : null
  }

  // Tattag/Uhrzeit aus den Fotos setzen: von = frühestes, bis = spätestes Foto.
  // bis bleibt leer, wenn alle Fotos in dieselbe Minute fallen.
  function applyPhotoTimes() {
    const range = getPhotoTimeRange()
    const form = document.querySelector('#report-form')
    if (!range || !form) return
    const von = toHHMM(range.min)
    const bis = toHHMM(range.max)
    setFieldValue(form.elements['tattag'], toDateValue(range.min))
    setFieldValue(form.elements['tatzeit_von'], von)
    if (bis !== von) setFieldValue(form.elements['tatzeit_bis'], bis)
  }

  // Button/Hinweis aktualisieren; bei allowAuto zusätzlich automatisch befüllen,
  // solange der Nutzer die Zeitfelder nicht selbst bearbeitet hat.
  function refreshPhotoTimes(allowAuto) {
    const row = document.querySelector('#photo-time-row')
    const status = document.querySelector('#photo-time-status')
    const range = getPhotoTimeRange()
    if (!range) {
      if (row) row.classList.add('d-none')
      if (status) status.textContent = ''
      return
    }
    if (row) row.classList.remove('d-none')
    const von = toHHMM(range.min)
    const bis = toHHMM(range.max)
    const span = bis !== von ? von + ' – ' + bis : von
    if (allowAuto && !userEditedTimes) {
      applyPhotoTimes()
      if (status) status.textContent = 'Aus den Fotos übernommen (' + span + ') – bitte prüfen.'
    } else if (status) {
      status.textContent = 'Aus den Fotos: ' + span
    }
  }

  function initPhotoTimes(form) {
    // Echte Nutzereingaben (isTrusted) markieren die Felder als manuell gepflegt;
    // programmatische input-Events aus setFieldValue lösen das nicht aus.
    ;['tattag', 'tatzeit_von', 'tatzeit_bis'].forEach((name) => {
      const el = form.elements[name]
      if (!el) return
      el.addEventListener('input', (e) => {
        if (e.isTrusted) userEditedTimes = true
      })
    })
    const btn = document.querySelector('#btn-photo-times')
    if (!btn) return
    btn.addEventListener('click', () => {
      applyPhotoTimes()
      const status = document.querySelector('#photo-time-status')
      const range = getPhotoTimeRange()
      if (status && range) {
        const von = toHHMM(range.min)
        const bis = toHHMM(range.max)
        const span = bis !== von ? von + ' – ' + bis : von
        status.textContent = 'Übernommen: ' + span + ' – bitte prüfen.'
      }
    })
  }

  // ---------------------------------------------------------------------------
  // 4. Autosave der Textfelder
  // ---------------------------------------------------------------------------

  const SAVE_FIELDS = [
    'kennzeichen',
    'kennzeichen_land',
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
    'fahrzeug_verlassen',
  ]

  function initAutosave(form) {
    const status = document.querySelector('#save-status')

    const save = debounce(async () => {
      const body = {}
      SAVE_FIELDS.forEach((n) => {
        const el = form.elements[n]
        if (!el) return
        // Checkboxen: value ist immer gesetzt – der Zustand steckt in checked.
        body[n] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value
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
  // Kennzeichen beim Tippen formatieren: Großschreibung, erster Trenner wird
  // zum Bindestrich, vor dem Ziffernblock steht automatisch ein Leerzeichen
  // ("F AB1234" / "F-AB1234" -> "F-AB 1234"). Ohne getippten Trenner bleibt die
  // Buchstabenfolge unangetastet (die Aufteilung wäre mehrdeutig, z.B. "FAB").
  function initKennzeichenFormat(form) {
    const el = form.elements['kennzeichen']
    if (!el) return
    el.addEventListener('input', () => {
      const m = el.value
        .toUpperCase()
        .replace(/[^A-ZÄÖÜ0-9 -]/g, '')
        // Nach den Ziffern optional E (Elektro) oder H (Oldtimer).
        .match(/^([A-ZÄÖÜ]{1,3})(?:[ -]+([A-ZÄÖÜ]{0,2}))?[ -]*(\d{0,4})?([EH])?/)
      if (!m) return
      let out = m[1]
      if (m[2] !== undefined) out += '-' + m[2]
      if (m[3]) out += ' ' + m[3] + (m[4] || '')
      if (out !== el.value) el.value = out
    })
  }

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

    // Schnellauswahl: Standard-Sätze per Klick ins Textfeld übernehmen
    // (angehängt, falls schon Text drinsteht); Autosave über input-Event.
    const textarea = form.elements['behinderung_text']
    if (!textarea) return
    detail.querySelectorAll('[data-behinderung-vorschlag]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const satz = btn.getAttribute('data-behinderung-vorschlag')
        const current = textarea.value.trim()
        if (current.includes(satz)) return
        textarea.value = current ? current + ' ' + satz : satz
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
    })
  }

  document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('#report-form[data-report-id]')
    if (!form) return
    reportId = form.dataset.reportId

    initCurrentLocation()
    initImageEditor()
    initAutosave(form)
    initBehinderung(form)
    initPhotoTimes(form)
    initKennzeichenFormat(form)
  })
})()
