// Zusatzfunktionen für das Entwurfs-Formular (/anzeige/:id/bearbeiten):
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
  // Läuft der Editor im Modal der Anzeigen-Liste (report-modal.js, ?embed=1)?
  let isEmbed = false
  let flushAutosave = null // von initAutosave gesetzt: offene Feld-Änderungen sofort sichern

  // Der Liste im Elternfenster melden, dass sich der Entwurf geändert hat
  // (structural = Fotos verschoben/neue Anzeige → Liste neu laden).
  function notifyParent(structural) {
    if (!isEmbed || window.parent === window) return
    try {
      window.parent.postMessage({ type: 'owia:changed', az: reportId, structural: !!structural }, location.origin)
    } catch (_) {
      /* Elternfenster weg */
    }
  }

  const debounce = window.OWIA.debounce

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

  // heic2any (1,3 MB) nur bei Bedarf nachladen: gebraucht wird es nur, wenn
  // ein frisch gewähltes HEIC-Foto bearbeitet wird, bevor der Server es als
  // JPEG gespeichert hat – vorher lud jeder Editor-Aufruf die Bibliothek mit.
  let heicLoader = null
  function loadHeic2any() {
    if (window.heic2any) return Promise.resolve(true)
    if (!heicLoader) {
      heicLoader = new Promise((resolve) => {
        const s = document.createElement('script')
        s.src = '/public/vendor/heic2any.min.js'
        s.onload = () => resolve(!!window.heic2any)
        s.onerror = () => resolve(false)
        document.head.appendChild(s)
      })
    }
    return heicLoader
  }

  async function toRasterBlob(file) {
    if (/^image\/(jpeg|png)$/.test(file.type) || /\.(jpe?g|png)$/i.test(file.name)) {
      return file
    }
    if (isHeic(file) && (await loadHeic2any())) {
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

  // Verlauf für „Rückgängig": Jede Änderung (Markierung, Zuschnitt, Drehung)
  // legt vorher einen Schnappschuss ab. Rotieren/Zuschneiden ersetzen
  // item.base durch einen NEUEN Canvas – die Referenz zu speichern genügt.
  // Dadurch braucht der Zuschnitt keine Sicherheitsabfrage mehr.
  function snapshot(item) {
    item.history.push({ base: item.base, redactions: item.redactions.slice(), edited: item.edited })
  }

  function restore(item, snap) {
    item.base = snap.base
    item.redactions = snap.redactions.slice()
    item.edited = snap.edited
    item.canvas.width = snap.base.width
    item.canvas.height = snap.base.height
    redraw(item)
    updateToolbar(item)
    item.saveDebounced()
  }

  function undoItem(item) {
    const snap = item.history.pop()
    if (snap) restore(item, snap)
  }

  // Alles zurück auf den Stand beim Öffnen (Verlauf bleibt für Rückgängig nicht nötig).
  function resetItem(item) {
    const first = item.history[0]
    if (!first) return
    item.history = []
    restore(item, first)
  }

  // Bild um 90° im Uhrzeigersinn drehen; vorhandene Markierungen drehen mit.
  function rotateItem(item) {
    if (!item.base) return
    snapshot(item)
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
    snapshot(item)

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
    setTool(item, null) // nach dem Zuschnitt zurück in den Ansichtsmodus
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
    // Rotieren/Zuschneiden bauen den Canvas neu auf – aktiven Werkzeug-Zustand
    // (editing-Klasse) dabei mitnehmen, sonst verliert setTool den Anker.
    canvas.className = 'img-redact' + (item.tool ? ' editing' : '')

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
    let activePointerId = null

    function toCanvasCoords(e) {
      const rect = canvas.getBoundingClientRect()
      return {
        x: ((e.clientX - rect.left) * canvas.width) / rect.width,
        y: ((e.clientY - rect.top) * canvas.height) / rect.height,
      }
    }

    canvas.addEventListener('pointerdown', (e) => {
      if (!item.tool) return // Ansichtsmodus: Wischen scrollt, kein Zeichnen
      // Zweiter Finger während des Zeichnens (Zoom-/Systemgeste): laufende
      // Markierung verwerfen statt eine riesige Box über beide Finger zu ziehen.
      if (drawing) {
        drawing = false
        redraw(item)
        return
      }
      if (!e.isPrimary) return
      drawing = true
      start = toCanvasCoords(e)
      activePointerId = e.pointerId
      canvas.setPointerCapture(e.pointerId)
    })

    canvas.addEventListener('pointermove', (e) => {
      if (!drawing || e.pointerId !== activePointerId) return
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
      if (!drawing || e.pointerId !== activePointerId) return
      drawing = false
      const p = toCanvasCoords(e)
      const x = Math.min(start.x, p.x)
      const y = Math.min(start.y, p.y)
      const w = Math.abs(p.x - start.x)
      const h = Math.abs(p.y - start.y)
      if (item.tool === 'crop') {
        // Mindestgröße, damit ein versehentlicher Klick nicht alles wegschneidet.
        // Keine Rückfrage: „Rückgängig" holt das ganze Bild zurück.
        if (w >= 40 && h >= 40) {
          applyCrop(item, { x, y, w, h })
          return
        }
      } else if (w >= MIN_BOX && h >= MIN_BOX) {
        snapshot(item)
        item.redactions.push({ x, y, w, h, type: item.tool === 'pixel' ? 'pixel' : 'black' })
        updateToolbar(item)
        item.saveDebounced()
      }
      redraw(item)
    }

    canvas.addEventListener('pointerup', finish)
    // Vom Browser abgebrochene Gesten (Systemgeste, Handballen) verwerfen die
    // Markierung – ein Commit hier hätte versehentliche Riesen-Boxen zur Folge.
    canvas.addEventListener('pointercancel', () => {
      drawing = false
      redraw(item)
    })
  }

  function updateToolbar(item) {
    if (!item.els) return
    const has = item.history.length > 0
    item.els.undo.disabled = !has
    item.els.clear.disabled = !has
    const tips = {
      black: 'Mit der Maus bzw. dem Finger Rechtecke über Gesichter oder fremde Kennzeichen ziehen.',
      pixel: 'Rechtecke über die zu verpixelnden Bereiche ziehen.',
      crop: 'Den Bildausschnitt aufziehen, der übrig bleiben soll.',
    }
    item.els.count.textContent = item.tool
      ? tips[item.tool]
      : item.redactions.length
        ? item.redactions.length + ' Bereich(e) unkenntlich gemacht'
        : ''
  }

  // Aktives Zeichen-Werkzeug der Karte umschalten (Schwärzen/Verpixeln/Zuschneiden);
  // tool = null ist der Ansichtsmodus. Die .editing-Klasse schaltet touch-action
  // um (CSS): nur mit aktivem Werkzeug fangen Wischgesten das Zeichnen ab.
  function setTool(item, tool) {
    item.tool = tool
    if (item.canvas) item.canvas.classList.toggle('editing', !!tool)
    if (item.els && item.els.toolBtns) {
      Object.keys(item.els.toolBtns).forEach((key) => {
        item.els.toolBtns[key].classList.toggle('btn-secondary', key === tool)
        item.els.toolBtns[key].classList.toggle('btn-outline-secondary', key !== tool)
      })
    }
    updateToolbar(item)
  }

  // ---------------------------------------------------------------------------
  // Foto-Karten: kompakte Vorschau (Server-Vorschaubild), Bearbeiten-Werkzeuge
  // ausklappbar. Das Vollbild wird erst beim Aufklappen geladen und in die
  // Leinwand gezeichnet – vorher lud der Editor JEDES Foto komplett herunter
  // und dekodierte es (spürbar langsamer Seitenaufbau bei mehreren Fotos).
  // ---------------------------------------------------------------------------

  function imageUrl(item, thumb) {
    if (!item.serverImageId) return null
    return (
      '/anzeige/' + reportId + '/image/' + item.serverImageId + (thumb ? '/thumb.jpg' : '') +
      '?v=' + encodeURIComponent(item.version || 'x')
    )
  }

  // Vorschaubild der Karte auf den aktuellen Stand bringen (nach Upload/Schwärzen).
  function refreshCardImage(item) {
    if (!item.els) return
    const thumb = imageUrl(item, true)
    if (thumb) {
      item.els.img.src = thumb
      item.els.img.setAttribute('data-full-src', imageUrl(item, false))
    } else if (item.previewUrl) {
      item.els.img.src = item.previewUrl
      item.els.img.setAttribute('data-full-src', item.previewUrl)
    }
    item.els.img.classList.toggle('is-placeholder', !thumb && !item.previewUrl)
  }

  function buildCard(item) {
    const col = document.createElement('div')
    col.className = 'photo-card'

    const media = document.createElement('div')
    media.className = 'photo-card-media'
    const img = document.createElement('img')
    img.className = 'photo-card-img'
    img.alt = 'Beweisfoto'
    img.decoding = 'async'
    img.title = 'Klick: groß anzeigen'
    media.appendChild(img)

    // Auswahl für „in andere Anzeige verschieben" (erst nach dem Speichern).
    const checkLabel = document.createElement('label')
    checkLabel.className = 'photo-card-check'
    checkLabel.title = 'Foto auswählen'
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.className = 'form-check-input'
    check.setAttribute('aria-label', 'Foto auswählen')
    check.disabled = true
    check.addEventListener('change', () => {
      col.classList.toggle('is-selected', check.checked)
      updateSelection()
    })
    checkLabel.appendChild(check)
    media.appendChild(checkLabel)

    const pos = document.createElement('span')
    pos.className = 'photo-card-pos'
    media.appendChild(pos)
    col.appendChild(media)

    // Leinwand zum Schwärzen – nur im aufgeklappten Bearbeiten-Modus sichtbar.
    const stage = document.createElement('div')
    stage.className = 'redact-stage'
    col.appendChild(stage)

    const meta = document.createElement('div')
    meta.className = 'photo-card-meta'
    const dateEl = document.createElement('span')
    const status = document.createElement('span')
    status.className = 'photo-card-status'
    meta.appendChild(dateEl)
    meta.appendChild(status)
    col.appendChild(meta)

    // Upload-Fortschritt (nur während des Hochladens sichtbar).
    const progressWrap = document.createElement('div')
    progressWrap.className = 'progress d-none'
    progressWrap.style.height = '4px'
    const progressBar = document.createElement('div')
    progressBar.className = 'progress-bar'
    progressWrap.appendChild(progressBar)
    col.appendChild(progressWrap)

    // Vorschläge aus dem Foto (Kennzeichen-Erkennung, GPS) als kleine Links.
    const hints = document.createElement('div')
    hints.className = 'photo-card-hints'
    const plateBtn = mkBtn('🚗', 'btn-link p-0')
    plateBtn.style.display = 'none'
    plateBtn.addEventListener('click', () => {
      if (!item.detectedPlate) return
      applyPlateToField(item.detectedPlate, 'Kennzeichen vom Foto übernommen – bitte prüfen.')
    })
    const gpsBtn = mkBtn('📍 Ort & Zeit', 'btn-link p-0')
    gpsBtn.title = 'Tatort und Uhrzeit aus diesem Foto übernehmen'
    gpsBtn.style.display = 'none'
    gpsBtn.addEventListener('click', () => applyGpsFromItem(item, gpsBtn))
    hints.appendChild(plateBtn)
    hints.appendChild(gpsBtn)
    col.appendChild(hints)

    // Aktionen: Reihenfolge (das erste Foto ist u.a. Karten-Marker), Bearbeiten
    // aufklappen, Entfernen.
    const actions = document.createElement('div')
    actions.className = 'photo-card-actions'
    const moveLeft = mkBtn('◀', 'btn-outline-secondary')
    moveLeft.title = 'Weiter nach vorne'
    moveLeft.setAttribute('aria-label', 'Foto weiter nach vorne')
    moveLeft.addEventListener('click', () => moveItem(item, -1))
    const moveRight = mkBtn('▶', 'btn-outline-secondary')
    moveRight.title = 'Weiter nach hinten'
    moveRight.setAttribute('aria-label', 'Foto weiter nach hinten')
    moveRight.addEventListener('click', () => moveItem(item, 1))
    const editBtn = mkBtn('Mehr …', 'btn-outline-secondary flex-fill')
    editBtn.title = 'Weitere Werkzeuge: Verpixeln, Drehen'
    editBtn.setAttribute('aria-expanded', 'false')
    editBtn.addEventListener('click', () => toggleTools(item))
    const remove = mkBtn('🗑', 'btn-outline-danger')
    remove.title = 'Foto entfernen'
    remove.setAttribute('aria-label', 'Foto entfernen')
    remove.addEventListener('click', () => removeItem(item))
    actions.appendChild(moveLeft)
    actions.appendChild(moveRight)
    actions.appendChild(editBtn)
    actions.appendChild(remove)

    // Die häufigsten Werkzeuge direkt auf der Karte: ein Klick öffnet das Foto
    // groß mit bereits aktivem Werkzeug – sofort losziehen.
    const quick = document.createElement('div')
    quick.className = 'photo-card-quick'
    const quickBlack = mkBtn('⬛ Schwärzen', 'btn-outline-dark flex-fill')
    quickBlack.title = 'Bereiche schwarz übermalen (Gesichter, fremde Kennzeichen)'
    quickBlack.addEventListener('click', () => openWithTool(item, 'black'))
    const quickCrop = mkBtn('✂️ Zuschneiden', 'btn-outline-dark flex-fill')
    quickCrop.title = 'Bildausschnitt wählen'
    quickCrop.addEventListener('click', () => openWithTool(item, 'crop'))
    quick.appendChild(quickBlack)
    quick.appendChild(quickCrop)
    col.appendChild(quick)
    col.appendChild(actions)

    // Ausklappbare Werkzeuge: Schwärzen, Verpixeln, Zuschneiden, Drehen. Jeder
    // Werkzeug-Button ist ein Toggle; ohne aktives Werkzeug scrollt Wischen
    // normal (sonst wird jede Wischgeste zur Schwärzung).
    const tools = document.createElement('div')
    tools.className = 'photo-card-tools'
    const toolbar = document.createElement('div')
    toolbar.className = 'redact-toolbar'
    const toolBlack = mkBtn('⬛ Schwärzen', 'btn-outline-secondary')
    toolBlack.title = 'Bereiche schwarz übermalen'
    toolBlack.addEventListener('click', () => setTool(item, item.tool === 'black' ? null : 'black'))
    const toolPixel = mkBtn('▩ Verpixeln', 'btn-outline-secondary')
    toolPixel.title = 'Bereiche verpixeln (z.B. Gesichter, fremde Kennzeichen)'
    toolPixel.addEventListener('click', () => setTool(item, item.tool === 'pixel' ? null : 'pixel'))
    const toolCrop = mkBtn('✂️ Zuschneiden', 'btn-outline-secondary')
    toolCrop.title = 'Bild auf einen Ausschnitt zuschneiden'
    toolCrop.addEventListener('click', () => setTool(item, item.tool === 'crop' ? null : 'crop'))
    const rotate = mkBtn('⟳ Drehen', 'btn-outline-secondary')
    rotate.title = 'Um 90° im Uhrzeigersinn drehen'
    rotate.addEventListener('click', () => rotateItem(item))
    const undo = mkBtn('↩︎ Rückgängig', 'btn-outline-secondary')
    undo.disabled = true
    undo.addEventListener('click', () => undoItem(item))
    const clear = mkBtn('Zurücksetzen', 'btn-outline-secondary')
    clear.title = 'Alle Änderungen dieser Sitzung verwerfen'
    clear.disabled = true
    clear.addEventListener('click', () => resetItem(item))
    const done = mkBtn('Fertig', 'btn-primary')
    done.addEventListener('click', () => toggleTools(item, false))
    ;[toolBlack, toolPixel, toolCrop, rotate, undo, clear, done].forEach((b) => toolbar.appendChild(b))
    tools.appendChild(toolbar)
    const count = document.createElement('div')
    count.className = 'small text-muted mt-1'
    tools.appendChild(count)
    const hint = document.createElement('div')
    hint.className = 'form-text mt-0'
    hint.textContent = 'Änderungen werden automatisch gespeichert. „Rückgängig" nimmt den letzten Schritt zurück – auch einen Zuschnitt.'
    tools.appendChild(hint)
    col.appendChild(tools)

    item.els = {
      col, img, check, pos, stage, count, status, date: dateEl, undo, clear, gpsBtn, plateBtn,
      moveLeft, moveRight, editBtn, progressWrap, progressBar,
      toolBtns: { black: toolBlack, pixel: toolPixel, crop: toolCrop },
    }
    return col
  }

  // Werkzeuge auf-/zuklappen. Beim ersten Aufklappen das Foto in die Leinwand
  // laden; die Karte nimmt dann die volle Breite ein (genug Fläche zum Zeichnen).
  async function toggleTools(item, force) {
    const open = typeof force === 'boolean' ? force : !item.els.col.classList.contains('is-editing')
    item.els.col.classList.toggle('is-editing', open)
    item.els.editBtn.setAttribute('aria-expanded', String(open))
    if (!open) {
      setTool(item, null)
      return
    }
    if (window.imagePreview) window.imagePreview.hide()
    item.els.col.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    await ensureMedia(item)
  }

  async function openWithTool(item, tool) {
    await toggleTools(item, true)
    if (item.canvas) setTool(item, tool)
  }

  // Vollbild laden und Leinwand aufbauen (einmalig).
  async function ensureMedia(item) {
    if (item.mediaPromise) return item.mediaPromise
    item.mediaPromise = (async () => {
      item.els.stage.textContent = 'Foto wird geladen …'
      // HEIC: lieber die serverseitig gewandelte JPEG-Fassung bearbeiten.
      if (item.file && isHeic(item.file) && item.serverImageId) item.file = null
      if (!item.file && item.serverImageId) {
        try {
          const res = await fetch(imageUrl(item, false))
          if (!res.ok) throw new Error('load failed')
          const blob = await res.blob()
          const type = blob.type || 'image/jpeg'
          const ext = type.indexOf('png') >= 0 ? 'png' : 'jpg'
          item.file = new File([blob], 'bild-' + item.serverImageId + '.' + ext, { type })
        } catch (_) {
          item.els.stage.textContent = 'Foto konnte nicht geladen werden.'
          item.mediaPromise = null
          return
        }
      }
      try {
        const blob = await toRasterBlob(item.file)
        if (!blob) {
          item.els.stage.textContent =
            'Bearbeiten ist für dieses Format im Browser nicht möglich – das Foto bleibt unverändert.'
          return
        }
        const img = await loadImage(blob)
        prepareCanvas(item, img)
        item.els.stage.textContent = ''
        item.els.stage.appendChild(item.canvas)
        updateToolbar(item)
      } catch (_) {
        item.els.stage.textContent = 'Bearbeiten nicht möglich – das Foto bleibt unverändert.'
      }
    })()
    return item.mediaPromise
  }

  // GPS aus der Datei eines neu gewählten Fotos lesen (bestehende Fotos
  // bringen die beim Upload gelesenen Koordinaten aus der DB mit).
  async function readGps(item) {
    if (!window.exifr || !item.file) return
    try {
      const g = await window.exifr.gps(item.file)
      if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) setItemGps(item, g.latitude, g.longitude)
    } catch (_) {
      /* keine GPS-Daten */
    }
  }

  function setItemGps(item, lat, lon) {
    item.gps = { latitude: lat, longitude: lon }
    item.els.gpsBtn.style.display = ''
    refreshPhotoGeo() // „Tatort aus Fotos" neben dem Tatort-Feld
  }

  async function applyGpsFromItem(item, btn) {
    if (!item.gps) return
    btn.disabled = true
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
        if (tStatus) tStatus.textContent = 'Uhrzeit aus Fotos übernommen (' + photoTimeSpanText(range) + ') – bitte prüfen.'
      }
    } catch (_) {
      if (status) status.textContent = 'Adresse konnte nicht ermittelt werden.'
    } finally {
      btn.disabled = false
    }
  }

  // Erkanntes Kennzeichen eines Fotos an der Karte anzeigen (Link ein-/ausblenden).
  function setItemPlate(item, plate) {
    item.detectedPlate = plate || null
    const btn = item.els && item.els.plateBtn
    if (!btn) return
    if (!item.detectedPlate) {
      btn.style.display = 'none'
      return
    }
    btn.textContent = '🚗 ' + item.detectedPlate
    btn.title = 'Erkanntes Kennzeichen ins Formular übernehmen'
    btn.style.display = ''
  }

  function newItem(file, serverImageId) {
    const item = {
      file,
      kind: 'passthrough',
      redactions: [],
      history: [], // Schnappschüsse für Rückgängig (s. snapshot)
      tool: null, // aktives Zeichen-Werkzeug: black | pixel | crop; null = Ansichtsmodus (Wischen scrollt)
      edited: false, // true nach Drehen/Zuschneiden (auch ohne Markierungen speichern)
      gps: null,
      els: null,
      serverImageId: serverImageId || null, // ID der gespeicherten Fassung im Entwurf
      version: null, // Cache-Busting der Bild-URLs (wechselt mit jeder Fassung)
      previewUrl: null, // lokale Vorschau eines frisch gewählten Fotos
      detectedPlate: null, // erkanntes Kennzeichen dieses Fotos (Hintergrund-Analyse)
      mediaPromise: null,
      saving: false,
      dirty: false,
    }
    item.saveDebounced = debounce(() => saveItem(item), SAVE_DEBOUNCE_MS)
    return item
  }

  // Neu ausgewähltes Bild: Karte anlegen, sofort zum Entwurf hochladen.
  function addItem(file, container) {
    const item = newItem(file, null)
    items.push(item)
    container.appendChild(buildCard(item))
    // Browser-taugliche Formate sofort lokal anzeigen; HEIC erst nach dem
    // Upload über das serverseitige Vorschaubild.
    if (/^image\/(jpeg|png)$/.test(file.type)) item.previewUrl = URL.createObjectURL(file)
    refreshCardImage(item)
    refreshPhotoUi()
    readGps(item)
    return saveItem(item) // Schwärzungen werden danach automatisch gespeichert
  }

  // Bereits gespeichertes Bild als Karte (Vorschaubild vom Server, kein Download).
  function addExistingItem(image, container) {
    const item = newItem(null, image.id)
    item.version = image.v || null
    item.takenAt = parseCapturedAt(image.capturedAt) // serverseitig gelesenes Aufnahmedatum
    items.push(item)
    container.appendChild(buildCard(item))
    refreshCardImage(item)
    item.els.img.loading = 'lazy'
    setItemDate(item)
    setItemPlate(item, image.detectedPlate)
    // GPS aus der DB (beim Upload aus dem Original gelesen): Die gespeicherte
    // Fassung hat nach HEIC-Konvertierung/Schwärzung oft kein EXIF mehr.
    if (Number.isFinite(image.gpsLat) && Number.isFinite(image.gpsLon)) setItemGps(item, image.gpsLat, image.gpsLon)
    item.els.check.disabled = false
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
    item.els.status.classList.toggle('text-danger', !!isError)
  }

  // Server-Aufnahmezeit 'YYYY-MM-DD HH:MM:SS' -> Date (als lokale Wanduhrzeit
  // interpretiert, kein Zeitzonen-Versatz). Null bei fehlendem/ungültigem Wert.
  function parseCapturedAt(str) {
    if (!str) return null
    const d = new Date(String(str).replace(' ', 'T'))
    return isNaN(d.getTime()) ? null : d
  }

  // Aufnahmedatum des Fotos auf der Karte anzeigen (aus item.takenAt).
  function setItemDate(item) {
    if (!item.els || !item.els.date) return
    const d = item.takenAt
    item.els.date.textContent =
      d instanceof Date && !isNaN(d.getTime())
        ? d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) + ', ' + toHHMM(d)
        : ''
  }

  // --- Upload-Fortschritt (wie beim Foto-Import, siehe import-upload.js) ---

  function fmtBytes(b) {
    if (b >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',') + ' GB'
    if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB'
    return Math.max(1, Math.round(b / 1024)) + ' KB'
  }

  // XHR statt fetch: nur so gibt es Upload-Progress-Events (Bytes im Flug).
  // Löst bei HTTP >= 400 mit Fehler aus.
  function uploadImage(url, method, fd, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open(method, url)
      xhr.responseType = 'json'
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total)
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 400) resolve(xhr.response || {})
        else reject(new Error('http ' + xhr.status))
      }
      xhr.onerror = () => reject(new Error('network'))
      xhr.ontimeout = () => reject(new Error('timeout'))
      xhr.send(fd)
    })
  }

  // Fortschritt an der Foto-Karte: Balken + kurze Prozentangabe; nach dem
  // Hochladen verarbeitet der Server das Foto noch (HEIC, EXIF).
  function itemProgress(item) {
    return (loaded, total) => {
      if (!item.els || !item.els.progressBar) return
      item.els.progressWrap.classList.remove('d-none')
      const pct = total ? Math.round((loaded / total) * 100) : 0
      item.els.progressBar.style.width = pct + '%'
      setItemStatus(item, pct < 100 ? 'Lädt hoch … ' + pct + ' % von ' + fmtBytes(total) : 'Wird verarbeitet …')
    }
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
      const onProgress = itemProgress(item)

      let savedId
      if (item.serverImageId) {
        const data = await uploadImage(
          '/anzeige/' + reportId + '/images/' + item.serverImageId,
          'PUT',
          fd,
          onProgress
        )
        savedId = data.image && data.image.id
      } else {
        const data = await uploadImage('/anzeige/' + reportId + '/images', 'POST', fd, onProgress)
        if (data.errors && data.errors.length) setItemStatus(item, data.errors[0], true)
        const newImg = (data.images || [])[0]
        savedId = newImg && newImg.id
        // Aufnahmedatum (serverseitig aus EXIF gelesen) übernehmen: Karte
        // beschriften und – bei frischem Upload – Tattag/Uhrzeit vorbefüllen.
        if (newImg && newImg.capturedAt) {
          item.takenAt = parseCapturedAt(newImg.capturedAt)
          setItemDate(item)
          refreshPhotoTimes(true)
        }
        if (!savedId && data.errors && data.errors.length) {
          // Abgelehnt (Duplikat, Limit, Format): Karte nach kurzer Anzeige entfernen.
          item.removed = true
          setTimeout(() => dropItem(item), 4000)
          return
        }
      }
      if (!savedId) throw new Error('not saved')
      item.serverImageId = savedId
      item.version = 'e' + Date.now()
      setItemStatus(item, 'Gespeichert ✓')
      item.els.check.disabled = false
      // Lokale Vorschau nur, solange die Karte kein Serverbild hat; nach dem
      // Schwärzen zeigt die Karte die neue Fassung.
      if (item.previewUrl && item.redactions.length === 0 && !item.edited) {
        item.els.img.setAttribute('data-full-src', imageUrl(item, false))
      } else {
        refreshCardImage(item)
      }
      // Server erkennt das Kennzeichen im Hintergrund – Ergebnis abholen.
      bumpAnalysisPolling()
      refreshPhotoUi()
      announceFirstImage() // neu gespeichertes (erstes) Bild -> Karten-Marker aktualisieren
      notifyParent(false)
    } catch (_) {
      setItemStatus(item, 'Nicht gespeichert – erneut versuchen.', true)
    } finally {
      // Fortschrittsbalken wieder ausblenden – der Ausgang steht in der Status-Zeile.
      if (item.els && item.els.progressWrap) {
        item.els.progressWrap.classList.add('d-none')
        item.els.progressBar.style.width = '0%'
      }
      item.saving = false
      if (item.dirty && !item.removed) {
        item.dirty = false
        saveItem(item)
      }
    }
  }

  // Karte aus Liste + DOM nehmen (ohne Server-Request).
  function dropItem(item) {
    item.removed = true
    const i = items.indexOf(item)
    if (i >= 0) items.splice(i, 1)
    if (item.els && item.els.col) item.els.col.remove()
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
    if (item.takenAt) refreshPhotoTimes(false) // Zeitspanne ohne dieses Foto neu anzeigen
    refreshPhotoGeo() // Tatort-Button ggf. ausblenden
    refreshPhotoUi()
    updateSelection()
    announceFirstImage() // erstes Bild könnte sich geändert haben -> Karten-Marker aktualisieren
  }

  // Bild aus dem Entwurf entfernen (Karte + serverseitig gespeicherte Fassung).
  async function removeItem(item) {
    if (!(await OWIA.ask('Foto aus dem Entwurf entfernen?', { danger: true, ok: 'Entfernen' }))) return
    dropItem(item)
    if (item.serverImageId) {
      fetch('/anzeige/' + reportId + '/images/' + item.serverImageId, { method: 'DELETE' })
        .then(() => notifyParent(false))
        .catch(() => {})
    }
  }

  // ---------------------------------------------------------------------------
  // Mehrfachauswahl: ausgewählte Fotos in eine neue oder bestehende Anzeige
  // verschieben (POST /anzeige/:az/images/move).
  // ---------------------------------------------------------------------------

  function selectedItems() {
    return items.filter((it) => it.els && it.els.check.checked && it.serverImageId)
  }

  function updateSelection() {
    const bar = document.querySelector('#photo-select-bar')
    if (!bar) return
    const n = selectedItems().length
    bar.hidden = n === 0
    document.querySelector('#photo-select-count').textContent =
      n === 1 ? '1 Foto ausgewählt' : n + ' Fotos ausgewählt'
  }

  function setMoveStatus(html, isError) {
    let box = document.querySelector('#photo-move-status')
    if (!box) {
      box = document.createElement('div')
      box.id = 'photo-move-status'
      box.setAttribute('role', 'status')
      document.querySelector('#photo-select-bar').after(box)
    }
    box.className = 'alert py-2 small mb-2 ' + (isError ? 'alert-danger' : 'alert-success')
    box.innerHTML = html
  }

  async function moveSelected(dest, label) {
    const sel = selectedItems()
    if (!sel.length) return
    const what = sel.length === 1 ? 'das ausgewählte Foto' : 'die ' + sel.length + ' ausgewählten Fotos'
    if (!await OWIA.ask(dest.newDraft ? 'Für ' + what + ' eine neue Anzeige anlegen?' : what.charAt(0).toUpperCase() + what.slice(1) + ' nach „' + label + '" verschieben?')) return
    const buttons = document.querySelectorAll('#photo-select-bar button, #photo-select-bar select')
    buttons.forEach((b) => (b.disabled = true))
    try {
      const res = await fetch('/anzeige/' + reportId + '/images/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.assign({ imageIds: sel.map((it) => it.serverImageId) }, dest)),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Verschieben fehlgeschlagen.')
      sel.forEach(dropItem)
      notifyParent(true)
      // Ziel direkt erreichbar machen (im Modal bleibt man im Modal).
      const href = '/anzeige/' + encodeURIComponent(data.targetAz) + '/bearbeiten' + (isEmbed ? '?embed=1' : '')
      setMoveStatus(
        (data.moved === 1 ? '1 Foto' : data.moved + ' Fotos') + ' verschoben nach <a href="' + href + '">' +
          data.targetAz + '</a>' + (dest.newDraft ? ' (neue Anzeige)' : '') + '.'
      )
      if (!dest.newDraft) {
        const opt = document.querySelector('#photo-move-target')
        if (opt) {
          opt.value = ''
          if (window.searchableSelect) window.searchableSelect.sync(opt)
        }
      }
    } catch (err) {
      setMoveStatus(err.message || 'Verschieben fehlgeschlagen.', true)
    } finally {
      buttons.forEach((b) => (b.disabled = false))
      updateSelection()
    }
  }

  // Ziel-Entwürfe für „Fotos verschieben": edit.ejs liefert sie als JSON-Block
  // #other-drafts (kein ausführbares Inline-Script, CSP).
  function otherDrafts() {
    const el = document.getElementById('other-drafts')
    try { return el ? JSON.parse(el.textContent) || [] : [] } catch (_) { return [] }
  }

  function initSelection() {
    const target = document.querySelector('#photo-move-target')
    if (!target) return
    const drafts = otherDrafts()
    drafts.forEach((d) => target.add(new Option(d.label, d.az)))
    if (!target.options.length || target.options.length === 1) target.hidden = !drafts.length
    target.addEventListener('change', () => {
      if (!target.value) return
      const label = target.options[target.selectedIndex].textContent
      moveSelected({ targetAz: target.value }, label).then(() => {
        target.value = ''
        if (window.searchableSelect) window.searchableSelect.sync(target)
      })
    })
    document.querySelector('#photo-move-new').addEventListener('click', () => moveSelected({ newDraft: true }))
    document.querySelector('#photo-select-clear').addEventListener('click', () => {
      items.forEach((it) => {
        if (!it.els) return
        it.els.check.checked = false
        it.els.col.classList.remove('is-selected')
      })
      updateSelection()
    })
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
        detail: { url: first ? '/anzeige/' + reportId + '/image/' + first + '/thumb.jpg' : null },
      })
    )
  }

  function persistImageOrder() {
    const order = currentOrderIds()
    announceFirstImage()
    if (order.length < 2) return
    fetch('/anzeige/' + reportId + '/images/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: order }),
    })
      .then(() => notifyParent(false))
      .catch(() => {})
  }

  // Positionsnummern, ◀/▶-Zustand, Fotozahl und Leer-Hinweis aktualisieren.
  function refreshPhotoUi() {
    const cols = orderedCols()
    cols.forEach((col, i) => {
      const it = items.find((x) => x.els && x.els.col === col)
      if (!it || !it.els) return
      it.els.moveLeft.disabled = i === 0
      it.els.moveRight.disabled = i === cols.length - 1
      it.els.pos.textContent = String(i + 1)
    })
    const count = document.querySelector('#photo-count')
    if (count) count.textContent = cols.length ? '(' + cols.length + ')' : ''
    const empty = document.querySelector('#photo-empty')
    if (empty) empty.hidden = cols.length > 0
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
    refreshPhotoUi()
    persistImageOrder()
  }

  async function addFiles(files, container) {
    for (const file of files) {
      if (!/^image\//.test(file.type) && !/\.(jpe?g|png|heic|heif)$/i.test(file.name)) continue
      await addItem(file, container)
    }
  }

  function initImageEditor() {
    const input = document.querySelector('#bilder-input')
    const container = document.querySelector('#image-editor')
    if (!input || !container) return

    input.addEventListener('change', async () => {
      const files = Array.from(input.files || [])
      input.value = ''
      await addFiles(files, container)
    })

    // Fotos auch per Drag & Drop aus dem Dateimanager in den Foto-Bereich.
    const section = document.querySelector('#photo-section')
    if (section) {
      const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') !== -1
      section.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        section.classList.add('is-dropping')
      })
      section.addEventListener('dragleave', (e) => {
        if (!section.contains(e.relatedTarget)) section.classList.remove('is-dropping')
      })
      section.addEventListener('drop', (e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        section.classList.remove('is-dropping')
        addFiles(Array.from(e.dataTransfer.files || []), container)
      })
    }

    // Bereits gespeicherte Bilder als Karten (nur Vorschaubilder laden).
    const dataEl = document.querySelector('#existing-images-data')
    if (dataEl) {
      let existing = []
      try {
        existing = JSON.parse(dataEl.textContent || '[]')
      } catch (_) {
        existing = []
      }
      existing.forEach((image) => addExistingItem(image, container))
      refreshPhotoTimes(false) // nur „Aus den Fotos: …" anzeigen, Felder nicht überschreiben
    }
    refreshPhotoUi()
    initSelection()
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
  // „bis" nur bei Tageswechsel oder ab 3 Minuten Abstand (wie services/tatzeit.ts).
  function isZeitraum(range) {
    if (toDateValue(range.min) !== toDateValue(range.max)) return true
    const min = (d) => d.getHours() * 60 + d.getMinutes()
    return min(range.max) - min(range.min) >= 3
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
  // bis bleibt leer, wenn weniger als 3 Minuten zwischen den Fotos liegen. Fällt das späteste
  // Foto auf einen anderen Tag (z.B. Dauerparken über Nacht), wird zusätzlich
  // "Tattag bis" gesetzt.
  function applyPhotoTimes() {
    const range = getPhotoTimeRange()
    const form = document.querySelector('#report-form')
    if (!range || !form) return
    const von = toHHMM(range.min)
    const bis = toHHMM(range.max)
    const vonTag = toDateValue(range.min)
    const bisTag = toDateValue(range.max)
    setFieldValue(form.elements['tattag'], vonTag)
    setFieldValue(form.elements['tatzeit_von'], von)
    if (bisTag !== vonTag) setFieldValue(form.elements['tattag_bis'], bisTag)
    if (isZeitraum(range)) setFieldValue(form.elements['tatzeit_bis'], bis)
  }

  // Zeitspanne der Fotos als Text, bei Tageswechsel mit Datum des Endes.
  function photoTimeSpanText(range) {
    const von = toHHMM(range.min)
    const bis = toHHMM(range.max)
    if (toDateValue(range.min) !== toDateValue(range.max)) {
      const d = range.max
      return von + ' – ' + pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear() + ', ' + bis
    }
    return isZeitraum(range) ? von + ' – ' + bis : von
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
    const span = photoTimeSpanText(range)
    if (allowAuto && !userEditedTimes) {
      applyPhotoTimes()
      if (status) status.textContent = 'Aus den Fotos übernommen (' + span + ') – bitte prüfen.'
    } else if (status) {
      status.textContent = 'Aus den Fotos: ' + span
    }
  }

  // ---------------------------------------------------------------------------
  // Tatort aus den GPS-Daten der Fotos übernehmen (Button neben dem Tatort-Feld;
  // pro Foto gibt es zusätzlich den Karten-Button "Standort & Zeit aus Foto").
  // ---------------------------------------------------------------------------

  // Erstes Foto (in Anzeige-Reihenfolge) mit GPS-Daten.
  function getPhotoGpsItem() {
    for (const it of items) {
      const g = it.gps
      if (g && Number.isFinite(g.latitude) && Number.isFinite(g.longitude)) return it
    }
    return null
  }

  // Button nur zeigen, wenn mindestens ein Foto GPS-Daten hat.
  function refreshPhotoGeo() {
    const btn = document.querySelector('#btn-photo-geo')
    if (btn) btn.classList.toggle('d-none', !getPhotoGpsItem())
  }

  function initPhotoGeo() {
    const btn = document.querySelector('#btn-photo-geo')
    if (!btn) return
    btn.addEventListener('click', async () => {
      const item = getPhotoGpsItem()
      if (!item) return
      btn.disabled = true
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
        btn.disabled = false
      }
    })
    refreshPhotoGeo()
  }

  function initPhotoTimes(form) {
    // Echte Nutzereingaben (isTrusted) markieren die Felder als manuell gepflegt;
    // programmatische input-Events aus setFieldValue lösen das nicht aus.
    ;['tattag', 'tattag_bis', 'tatzeit_von', 'tatzeit_bis'].forEach((name) => {
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
        status.textContent = 'Übernommen: ' + photoTimeSpanText(range) + ' – bitte prüfen.'
      }
    })
  }

  // ---------------------------------------------------------------------------
  // Kennzeichen-Erkennung: Der Server analysiert hochgeladene Fotos im
  // Hintergrund (YOLO + OCR im alpr-Container); das Formular pollt das Ergebnis
  // und befüllt ein noch leeres, unangefasstes Kennzeichen-Feld vor. Manuelle
  // Eingaben werden nie überschrieben – der Nutzer prüft und speichert wie gewohnt.
  // ---------------------------------------------------------------------------

  let plateTouched = false // Nutzer hat das Feld selbst geändert (nur echte Events)
  let plateHintShown = false // Vorschlags-Hinweis sichtbar -> nicht mehr überschreiben
  let plateForm = null
  let plateTimer = null
  let plateStopAt = 0

  function setPlateStatus(text) {
    const box = document.querySelector('#alpr-status')
    if (box) box.textContent = text || ''
  }

  // Ladeanimation, solange der Server noch Fotos analysiert. Erscheint erst
  // nach einer echten "pending"-Antwort (kein Aufblitzen, wenn die Analyse
  // deaktiviert oder längst fertig ist).
  function setPlateLoading() {
    const box = document.querySelector('#alpr-status')
    if (!box || box.querySelector('.spinner-border')) return
    box.innerHTML =
      '<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>' +
      'Kennzeichen wird aus den Fotos gelesen …'
  }

  // Manuelle Eingaben merken (isTrusted nur bei echten Nutzer-Events), damit die
  // Erkennung nichts überschreibt, was der Nutzer selbst getippt hat.
  function initPlateTouchTracking(form) {
    const el = form.elements['kennzeichen']
    if (!el || typeof el.addEventListener !== 'function') return
    const mark = (e) => {
      if (e.isTrusted) plateTouched = true
    }
    el.addEventListener('input', mark)
    el.addEventListener('change', mark)
  }

  // Kennzeichen ins Formularfeld schreiben und Formatierung + Autosave auslösen.
  // Programmatische Events haben isTrusted=false, daher wird das Feld nicht
  // fälschlich als „vom Nutzer angefasst" markiert.
  function applyPlateToField(plate, statusText) {
    const form = plateForm || document.querySelector('#report-form[data-report-id]')
    const el = form && form.elements['kennzeichen']
    if (!el || !plate) return
    el.value = plate
    el.dispatchEvent(new Event('input'))
    el.dispatchEvent(new Event('change'))
    el.classList.remove('alpr-filled')
    void el.offsetWidth // Reflow, damit die Animation erneut startet
    el.classList.add('alpr-filled')
    setPlateStatus(statusText)
    plateHintShown = true
  }

  function applyPlateSuggestion(form, suggestions) {
    const el = form.elements['kennzeichen']
    const val = suggestions && suggestions.kennzeichen
    if (!el || !val || plateTouched || String(el.value || '').trim()) return false
    const pct =
      typeof suggestions.confidence === 'number' ? Math.round(suggestions.confidence * 100) : null
    applyPlateToField(
      val,
      'Kennzeichen aus den Fotos erkannt' + (pct !== null ? ' (' + pct + ' %)' : '') + ' – bitte prüfen.'
    )
    return true
  }

  // Marke/Farbe aus den Fotos (gleicher Analyse-Endpunkt): nur in leere Felder,
  // die der Nutzer in dieser Sitzung nicht angefasst hat. Der Server hat sie
  // meist schon vorbefüllt; hier geht es um ein offenes Formular, dessen
  // Autosave sonst den leeren Stand zurückschreiben würde.
  const fahrzeugTouched = {}

  function initFahrzeugTouchTracking(form) {
    ;['fahrzeug_marke', 'fahrzeug_farbe'].forEach((name) => {
      const el = form.elements[name]
      if (!el || typeof el.addEventListener !== 'function') return
      const mark = (e) => {
        if (e.isTrusted) fahrzeugTouched[name] = true
      }
      el.addEventListener('input', mark)
      el.addEventListener('change', mark)
    })
  }

  function applyFahrzeugSuggestion(form, suggestions) {
    ;['fahrzeug_marke', 'fahrzeug_farbe'].forEach((name) => {
      const el = form.elements[name]
      const val = suggestions && suggestions[name]
      if (!el || !val || fahrzeugTouched[name] || String(el.value || '').trim()) return
      el.value = val
      el.dispatchEvent(new Event('input'))
      el.dispatchEvent(new Event('change'))
      el.classList.remove('alpr-filled')
      void el.offsetWidth
      el.classList.add('alpr-filled')
      el.title = 'Aus den Fotos erkannt – bitte prüfen.'
    })
  }

  // Modell: nur ein anklickbarer Vorschlag unter dem leeren Feld (ungemessen,
  // daher nie automatisch eingetragen).
  let modellVorschlag = null

  function renderModellVorschlag(form) {
    const btn = document.querySelector('#modell-vorschlag')
    const el = form.elements['fahrzeug_modell']
    if (!btn || !el) return
    btn.hidden = !modellVorschlag || !!String(el.value || '').trim()
    btn.textContent = modellVorschlag ? 'Vorschlag: ' + modellVorschlag + '?' : ''
  }

  function initModellVorschlag(form) {
    const btn = document.querySelector('#modell-vorschlag')
    const el = form.elements['fahrzeug_modell']
    if (!btn || !el) return
    btn.addEventListener('click', () => {
      if (!modellVorschlag) return
      el.value = modellVorschlag
      // change löst den Autosave aus (wie eine Eingabe des Nutzers)
      el.dispatchEvent(new Event('input'))
      el.dispatchEvent(new Event('change'))
      renderModellVorschlag(form)
    })
    el.addEventListener('input', () => renderModellVorschlag(form))
  }

  async function pollAnalysisOnce(form) {
    try {
      const res = await fetch('/anzeige/' + reportId + '/analysis', {
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) return { status: 'done' }
      const data = await res.json()
      // Erst übernehmen, wenn alle Fotos analysiert sind: Der Vorschlag ist die
      // Mehrheit über alle Fotos, ein Zwischenstand könnte ein anderes Auto sein.
      if (data && data.suggestions && data.status !== 'pending') {
        applyPlateSuggestion(form, data.suggestions)
        applyFahrzeugSuggestion(form, data.suggestions)
        modellVorschlag = data.suggestions.fahrzeug_modell || null
        renderModellVorschlag(form)
      }
      // Einzelergebnisse an den Foto-Karten aktualisieren ("Kennzeichen übernehmen").
      if (data && Array.isArray(data.images)) {
        data.images.forEach((info) => {
          const it = items.find((x) => x.serverImageId === info.id)
          if (it) setItemPlate(it, info.kennzeichen)
        })
      }
      return data || { status: 'done' }
    } catch (_) {
      return { status: 'done' }
    }
  }

  // Polling starten bzw. „verlängern" (z.B. nach einem weiteren Upload).
  function bumpAnalysisPolling() {
    const form = plateForm || document.querySelector('#report-form[data-report-id]')
    if (!form || !reportId) return
    plateForm = form
    plateStopAt = Date.now() + 120000 // höchstens 2 Minuten pollen
    if (plateTimer) return // läuft bereits
    const tick = async () => {
      const data = await pollAnalysisOnce(form)
      if (data.status === 'pending' && Date.now() <= plateStopAt) {
        if (!plateHintShown) setPlateLoading()
        return
      }
      // fertig (oder Zeitlimit): Spinner ausblenden, Vorschlags-Hinweis bleibt.
      if (!plateHintShown) setPlateStatus('')
      clearInterval(plateTimer)
      plateTimer = null
    }
    plateTimer = setInterval(tick, 3000)
    tick()
  }

  // ---------------------------------------------------------------------------
  // 4. Autosave der Textfelder
  // ---------------------------------------------------------------------------

  const SAVE_FIELDS = [
    'kennzeichen',
    'kennzeichen_land',
    'fahrzeug_marke',
    'fahrzeug_typ',
    'fahrzeug_modell',
    'fahrzeug_farbe',
    'verstoss_variante',
    'tattag',
    'tattag_bis',
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
    'city',
  ]

  function initAutosave(form) {
    const status = document.querySelector('#save-status')
    let dirty = false // ungespeicherte Änderung vorhanden?

    function collect() {
      const body = {}
      SAVE_FIELDS.forEach((n) => {
        const el = form.elements[n]
        if (!el) return
        // Checkboxen: value ist immer gesetzt – der Zustand steckt in checked.
        body[n] = el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value
      })
      return body
    }

    async function doSave(useKeepalive) {
      if (status) status.textContent = 'Speichert …'
      try {
        const res = await fetch('/anzeige/' + reportId, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collect()),
          // keepalive: Beim Verlassen der Seite darf der Request noch zu Ende laufen.
          keepalive: !!useKeepalive,
        })
        // dirty nur bei Erfolg zurücksetzen – sonst bleibt das pagehide-
        // Sicherheitsnetz scharf und versucht den Save beim Verlassen erneut.
        if (res.ok) {
          dirty = false
          notifyParent(false)
        }
        if (status) status.textContent = res.ok ? 'Gespeichert ✓' : 'Nicht gespeichert'
      } catch (_) {
        if (status) status.textContent = 'Nicht gespeichert'
      }
    }

    const save = debounce(() => doSave(false), SAVE_DEBOUNCE_MS)

    SAVE_FIELDS.forEach((n) => {
      const el = form.elements[n]
      if (!el) return
      // Radio-Gruppen (z.B. behinderung) liefern eine RadioNodeList ohne
      // addEventListener – dann an jedem einzelnen Radio lauschen.
      const nodes = typeof el.addEventListener === 'function' ? [el] : Array.from(el)
      const onEdit = () => {
        dirty = true
        save()
      }
      nodes.forEach((node) => {
        node.addEventListener('input', onEdit)
        node.addEventListener('change', onEdit)
      })
    })

    // Sicherheitsnetz: eine kurz vor dem Verlassen/Wechseln der Seite gemachte
    // Änderung (noch im Debounce) sofort sichern, damit nichts verloren geht.
    const flush = () => {
      if (dirty) doSave(true)
    }
    // Für Modal-Schließen/„Speichern & schließen": sofort (ohne Debounce) sichern.
    flushAutosave = () => (dirty ? doSave(false) : Promise.resolve())
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
    window.addEventListener('pagehide', flush)
  }

  // Kennzeichen nur in Großschreibung wandeln – bewusst KEIN Formatzwang:
  // Ausländische Kennzeichen, Roller-Versicherungskennzeichen („123 ABC") oder
  // Sonderkennzeichen folgen keinem gemeinsamen Muster. Cursor bleibt stehen.
  function initKennzeichenFormat(form) {
    const el = form.elements['kennzeichen']
    if (!el) return
    el.addEventListener('input', () => {
      const up = el.value.toLocaleUpperCase('de-DE')
      if (up === el.value) return
      const pos = el.selectionStart
      el.value = up
      try {
        el.setSelectionRange(pos, pos)
      } catch (_) {
        /* nicht unterstützt */
      }
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

  // ---------------------------------------------------------------------------
  // Zuständiges Ordnungsamt: aus dem Tatort erkennen (PLZ -> /api/geo/authority),
  // Dropdown automatisch setzen, bei nicht freigeschalteten Orten warnen. Der
  // Nutzer kann die Stadt jederzeit manuell umstellen (dann keine Auto-Korrektur).
  // ---------------------------------------------------------------------------
  function initCity() {
    const select = document.getElementById('city-select')
    if (!select) return
    const hintName = document.getElementById('city-ordnungsamt')
    const hintEmail = document.getElementById('city-email')
    const warning = document.getElementById('city-warning')
    let userTouched = false

    function selectedOption() {
      return select.options[select.selectedIndex] || null
    }
    function updateHint() {
      const opt = selectedOption()
      if (!opt) return
      if (hintName) hintName.textContent = opt.getAttribute('data-ordnungsamt') || ''
      if (hintEmail) hintEmail.textContent = opt.getAttribute('data-email') || ''
    }
    function showWarning(msg) {
      if (!warning) return
      warning.textContent = msg || ''
      warning.classList.toggle('d-none', !msg)
    }
    function plzFrom(detail) {
      if (detail && /^\d{5}$/.test(String(detail.postcode || ''))) return String(detail.postcode)
      const m = /\b(\d{5})\b/.exec((detail && detail.label) || '')
      return m ? m[1] : null
    }
    function recenter() {
      const opt = selectedOption()
      const lat = opt && Number(opt.getAttribute('data-center-lat'))
      const lon = opt && Number(opt.getAttribute('data-center-lon'))
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        document.dispatchEvent(new CustomEvent('city:changed', { detail: { lat: lat, lon: lon } }))
      }
    }

    select.addEventListener('change', (e) => {
      if (e.isTrusted) {
        userTouched = true // manuelle Wahl -> Auto-Erkennung überschreibt nicht mehr
        showWarning(null)
        recenter()
      }
      updateHint()
      // Verstoß-Auswahl: Sperrliste der neuen Stadt (Frankfurt-Portal).
      const vs = document.querySelector('[data-verstoss-select]')
      if (vs) vs.dataset.city = select.value
    })

    async function handleLocation(e) {
      const plz = plzFrom(e.detail || {})
      if (!plz) return showWarning(null)
      let data
      try {
        const res = await fetch('/api/geo/authority?plz=' + encodeURIComponent(plz), {
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) return
        data = await res.json()
      } catch (_) {
        return
      }
      if (!data) return
      if (data.status === 'unlocked') {
        showWarning(null)
        if (!userTouched && select.value !== data.cityId) {
          select.value = data.cityId
          updateHint()
          select.dispatchEvent(new Event('change', { bubbles: true })) // Autosave + Karte
        } else {
          updateHint()
        }
      } else if (data.status === 'locked') {
        showWarning(
          'Für ' + (data.name || 'diesen Ort') + ' ist OWiA noch nicht freigeschaltet. ' +
          'Zuständig wäre: ' + (data.email || 'unbekannt') + '. ' +
          'Aktuell werden nur die oben wählbaren Städte unterstützt.'
        )
      } else {
        showWarning(null)
      }
    }
    // Adresse neu gewählt (Autocomplete/Standort/Foto) ODER Marker verschoben:
    // beides ändert den Tatort -> zuständiges Amt neu erkennen.
    document.addEventListener('address:selected', handleLocation)
    document.addEventListener('tatort:changed', handleLocation)

    updateHint()
  }

  // ---------------------------------------------------------------------------
  // Editor im Modal (report-modal.js): Speichern & schließen, Verwerfen und
  // „offene Änderungen sichern" auf Zuruf der Liste.
  // ---------------------------------------------------------------------------
  function busyUploads() {
    return items.some((it) => it.saving || it.dirty)
  }

  function initEmbed(form) {
    window.addEventListener('message', async (e) => {
      if (e.origin !== location.origin || e.source !== window.parent || !e.data) return
      if (e.data.type !== 'owia:flush') return
      try {
        if (flushAutosave) await flushAutosave()
      } catch (_) {
        /* Status zeigt den Fehler */
      }
      window.parent.postMessage({ type: 'owia:flushed', busy: busyUploads() }, location.origin)
    })

    // In der Import-Queue normal absenden (Weiterleitung zum nächsten Entwurf,
    // embed bleibt über das Hidden-Feld erhalten); sonst speichern und schließen.
    if (!form.dataset.queue) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault()
        const btn = document.querySelector('#btn-save')
        const status = document.querySelector('#save-status')
        if (busyUploads() && !(await OWIA.ask('Fotos werden noch hochgeladen. Trotzdem schließen?'))) return
        if (btn) btn.disabled = true
        if (status) status.textContent = 'Speichert …'
        try {
          if (flushAutosave) await flushAutosave()
          const res = await fetch(form.action, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(new FormData(form)).toString(),
          })
          if (!res.ok || res.redirected) throw new Error()
          notifyParent(false)
          window.parent.postMessage({ type: 'owia:close' }, location.origin)
        } catch (_) {
          if (status) status.textContent = 'Nicht gespeichert – bitte erneut versuchen.'
        } finally {
          if (btn) btn.disabled = false
        }
      })
    }

    // Verwerfen im iframe per fetch: verschiebt in den Papierkorb.
    const discard = document.querySelector('#btn-discard')
    if (discard) {
      discard.addEventListener('click', async (e) => {
        e.preventDefault()
        discard.disabled = true
        try {
          const res = await fetch('/anzeige/' + encodeURIComponent(reportId) + '/discard', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          })
          if (!res.ok) throw new Error()
          notifyParent(true)
          window.parent.postMessage({ type: 'owia:close' }, location.origin)
        } catch (_) {
          discard.disabled = false
          OWIA.alert('Löschen fehlgeschlagen.')
        }
      })
    }
  }

  // „Speichern & Einreichen": offene Änderungen sichern, Entwurf speichern
  // (PDF), dann einreichen. Fehler (fehlende Pflichtfelder, Profil, Stadt)
  // erscheinen direkt in der Aktionsleiste statt per Umleitung.
  // Verjährung (Spiegel von src/services/verjaehrung.ts): 3 Monate ab Tatende
  // (tattag_bis, sonst tattag). Verjährt → Hinweis + „Einreichen" gesperrt.
  // Tatbestand-Variante + „länger als 1 Stunde"-Vorschlag (Daten aus
  // #formular-hilfen, services/portalFfm.ts formularHilfen).
  function initVariante(form) {
    const dataEl = document.querySelector('#formular-hilfen')
    const row = document.querySelector('#verstoss-variante-row')
    const sel = document.querySelector('#verstoss-variante')
    const hint = document.querySelector('#langparker-hint')
    const apply = document.querySelector('#langparker-apply')
    const hidden = form.elements['verstoss_art']
    if (!dataEl || !row || !sel || !hidden) return
    const hilfen = JSON.parse(dataEl.textContent || '{}')
    function minutes() {
      const hm = (v) => (/^(\d{2}):(\d{2})/.exec(v || '') || null)
      const a = hm(form.elements['tatzeit_von'] && form.elements['tatzeit_von'].value)
      const b = hm(form.elements['tatzeit_bis'] && form.elements['tatzeit_bis'].value)
      if (!a || !b) return null
      let d = (+b[1] * 60 + +b[2]) - (+a[1] * 60 + +a[2])
      const bisTag = form.elements['tattag_bis'] && form.elements['tattag_bis'].value
      const tag = form.elements['tattag'] && form.elements['tattag'].value
      if (bisTag && tag && bisTag > tag) d += 1440
      return d
    }
    function render() {
      const v = hidden.value
      const opts = (hilfen.varianten || {})[v] || []
      const cur = sel.value || sel.dataset.current || ''
      row.hidden = !opts.length
      sel.innerHTML = '<option value="">Bitte wählen …</option>' +
        opts.map((o) => '<option' + (o === cur ? ' selected' : '') + '>' + o.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</option>').join('')
      if (!opts.length) sel.value = ''
      sel.classList.toggle('is-invalid', !!opts.length && !sel.value)
      const lang = (hilfen.langparker || {})[v]
      const m = minutes()
      hint.hidden = !(lang && m !== null && m > 60)
      if (lang) apply.textContent = '→ „' + lang.replace(/^\d{6} – /, '') + '" übernehmen'
      apply.dataset.label = lang || ''
    }
    hidden.addEventListener('change', () => { sel.dataset.current = ''; render() })
    sel.addEventListener('change', () => { sel.dataset.current = sel.value; render() })
    ;['tatzeit_von', 'tatzeit_bis', 'tattag', 'tattag_bis'].forEach((n) => {
      const el = form.elements[n]
      if (el) el.addEventListener('change', render)
    })
    apply.addEventListener('click', () => {
      const label = apply.dataset.label
      if (!label) return
      hidden.value = label
      const vis = form.querySelector('[data-verstoss-input]')
      if (vis) vis.value = label
      hidden.dispatchEvent(new Event('input', { bubbles: true }))
      hidden.dispatchEvent(new Event('change', { bubbles: true }))
    })
    render()
  }

  function initVerjaehrung(form) {
    const hint = document.querySelector('#verjaehrung-hint')
    const btn = document.querySelector('#btn-submit')
    const von = form.querySelector('[name="tattag"]')
    const bis = form.querySelector('[name="tattag_bis"]')
    if (!hint || !von) return
    const box = hint.querySelector('[data-verjaehrung-text]')
    const parse = (v) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '')
      return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null
    }
    const update = () => {
      const tat = parse(bis && bis.value) || parse(von.value)
      let rest = null
      if (tat) {
        // Monate: Verjährung (3) oder kürzere Annahmefrist der Stadt (edit.ejs).
        const ab = new Date(tat.getFullYear(), tat.getMonth() + (Number(hint.dataset.monate) || 3), tat.getDate())
        if (ab.getDate() !== tat.getDate()) ab.setDate(1)
        const n = new Date()
        rest = Math.round((ab - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000)
      }
      const verjaehrt = rest !== null && rest <= 0
      const bald = rest !== null && rest > 0 && rest <= 14
      hint.hidden = !verjaehrt && !bald
      box.className = 'alert ' + (verjaehrt ? 'alert-danger' : 'alert-warning') + ' py-2 px-3 small mb-0'
      box.textContent = verjaehrt
        ? '⌛ ' + (hint.dataset.text || 'Die Tat liegt mehr als drei Monate zurück und ist verjährt.') + ' Einreichen ist nicht mehr möglich.'
        : bald ? '⏳ ' + (Number(hint.dataset.monate) < 3 ? 'Frist endet' : 'Verjährt') + ' in ' + rest + ' Tag' + (rest === 1 ? '' : 'en') + ' – bitte bald einreichen.' : ''
      if (btn) {
        btn.disabled = verjaehrt
        btn.title = verjaehrt ? 'Verjährt – Einreichen nicht mehr möglich' : ''
      }
    }
    von.addEventListener('change', update)
    if (bis) bis.addEventListener('change', update)
    update()
  }

  function initSubmit(form) {
    const btn = document.querySelector('#btn-submit')
    const errBox = document.querySelector('#submit-error')
    if (!btn) return
    const post = (url, body) =>
      fetch(url, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      })
    btn.addEventListener('click', async () => {
      if (busyUploads() && !(await OWIA.ask('Fotos werden noch hochgeladen. Trotzdem jetzt einreichen?'))) return
      errBox.hidden = true
      btn.disabled = true
      const label = btn.textContent
      btn.textContent = 'Wird eingereicht …'
      try {
        if (flushAutosave) await flushAutosave()
        const saved = await post(form.action, new URLSearchParams(new FormData(form)).toString())
        if (!saved.ok || saved.redirected) throw new Error('Speichern fehlgeschlagen – bitte erneut versuchen.')
        const res = await post('/anzeige/' + encodeURIComponent(reportId) + '/submit', '')
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          const err = new Error(data.error || 'Einreichen fehlgeschlagen.')
          err.redirect = data.redirect
          throw err
        }
        notifyParent(true)
        if (isEmbed && !form.dataset.queue) {
          window.parent.postMessage({ type: 'owia:close' }, location.origin)
        } else {
          location.href = btn.dataset.after
        }
      } catch (err) {
        errBox.textContent = err.message
        // Profil unvollständig: Link zu den Einstellungen (im Modal: neuer Tab).
        if (err.redirect === '/einstellungen') {
          const a = document.createElement('a')
          a.href = '/einstellungen'
          a.textContent = ' Zu den Einstellungen →'
          if (isEmbed) a.target = '_blank'
          errBox.appendChild(a)
        }
        errBox.hidden = false
        btn.disabled = false
        btn.textContent = label
      }
    })
  }

  document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('#report-form[data-report-id]')
    if (!form) return
    reportId = form.dataset.reportId
    isEmbed = form.hasAttribute('data-embed') && window.parent !== window
    if (isEmbed) initEmbed(form)
    initSubmit(form)
    initVerjaehrung(form)
    initVariante(form)

    initCurrentLocation()
    initImageEditor()
    initAutosave(form)
    initBehinderung(form)
    initPhotoTimes(form)
    initPhotoGeo()
    initKennzeichenFormat(form)
    initPlateTouchTracking(form)
    initFahrzeugTouchTracking(form)
    initModellVorschlag(form)
    initCity()
    // Beim Laden einmal pollen: Ergebnisse können seit dem letzten Besuch fertig
    // sein, oder ein gerade hochgeladenes Bild wird noch analysiert.
    bumpAnalysisPolling()
  })
})()
