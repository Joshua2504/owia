// Tatort-Karte auf der Bearbeiten-Seite (/report/:id/edit).
//
// Zeigt den Tatort als verschiebbaren Marker. Tiles kommen same-origin über
// /tiles/{z}/{x}/{y}.png (Proxy auf den OSM-Tileserver, siehe src/routes/tiles.ts).
// Geocoding bleibt Sache von Photon (/api/geo/*): Beim Verschieben des Markers
// wird per Reverse-Geocoding die Adresse aktualisiert.
//
// Kopplung an die übrigen Skripte nur über das Custom-Event "address:selected"
// ({ lat, lon, label }), das Autocomplete/Standort/Foto dispatchen. So bleibt
// dieses Skript die einzige Stelle, die Leaflet kennt.
(function () {
  // Standard-Marker-Icons explizit auf die lokal mitgelieferten Bilder setzen –
  // sonst sucht Leaflet sie relativ zum eigenen Pfad und liefert 404 (graues Icon).
  if (window.L && L.Icon && L.Icon.Default) {
    const base = '/public/vendor/leaflet/images/'
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: base + 'marker-icon-2x.png',
      iconUrl: base + 'marker-icon.png',
      shadowUrl: base + 'marker-shadow.png',
    })
  }

  function num(v) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  // Marker als kleines Vorschaubild (erstes Beweisfoto) statt Standard-Pin.
  function imageIcon(url) {
    const size = 48
    return L.divIcon({
      className: 'photo-marker',
      html:
        '<img src="' +
        encodeURI(url) +
        '" alt="" style="width:' +
        size +
        'px;height:' +
        size +
        'px;object-fit:cover;border-radius:8px;border:2px solid #0d6efd;box-shadow:0 1px 4px rgba(0,0,0,.45)">',
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    })
  }

  // Hinweis-Banner oben auf der Karte, falls die Kacheln (noch) nicht verfügbar
  // sind – z.B. weil der Tileserver nach einem Update neu importiert. Blendet
  // sich aus, sobald die erste Kachel erfolgreich lädt.
  function attachTileStatus(el, tileLayer) {
    if (getComputedStyle(el).position === 'static') el.style.position = 'relative'
    const banner = document.createElement('div')
    banner.className = 'alert alert-warning small shadow-sm'
    banner.style.cssText = 'position:absolute;top:8px;left:8px;right:8px;z-index:1000;margin:0'
    banner.textContent =
      'Wir haben ein Update durchgeführt und die Karte wird serverseitig neu ' +
      'verarbeitet. Bitte komm in ein paar Minuten wieder.'
    banner.style.display = 'none'
    el.appendChild(banner)
    let ok = false
    tileLayer.on('tileload', () => {
      ok = true
      banner.style.display = 'none'
    })
    tileLayer.on('tileerror', () => {
      if (!ok) banner.style.display = 'block'
    })
  }

  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('tatort-map')
    if (!el || !window.L) return

    const latInput = document.querySelector('input[name="tatort_lat"]')
    const lonInput = document.querySelector('input[name="tatort_lon"]')
    const tatortInput = document.querySelector('#tatort')

    let thumbUrl = el.dataset.thumb || null // erstes Beweisfoto als Marker (falls vorhanden)
    const startLat = num(el.dataset.lat)
    const startLon = num(el.dataset.lon)
    const centerLat = num(el.dataset.centerLat) || 50.1109
    const centerLon = num(el.dataset.centerLon) || 8.6821
    const hasPoint = startLat !== null && startLon !== null

    // Solange noch kein Standort gewählt wurde, den Stadtmittelpunkt als Default
    // verwenden (für Frankfurt der Hauptbahnhof – siehe city.geo.mapLat/mapLon).
    const initLat = hasPoint ? startLat : centerLat
    const initLon = hasPoint ? startLon : centerLon

    const map = L.map(el).setView([initLat, initLon], hasPoint ? 16 : 13)
    const tiles = L.tileLayer('/tiles/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap-Mitwirkende',
    }).addTo(map)
    // Amtliche Luftbilder (Land Hessen, same-origin geproxt – siehe sat.ts).
    const satellite = L.tileLayer('/sat/{z}/{x}/{y}.jpg', {
      maxZoom: 19,
      attribution: '© Land Hessen (HVBG), dl-de/zero-2.0',
    })
    L.control
      .layers({ Straße: tiles, Satellit: satellite }, null, { position: 'topright' })
      .addTo(map)
    attachTileStatus(el, tiles)

    // Leaflet rendert in Containern, die beim Init evtl. noch kein finales
    // Layout haben, sonst grau – nach kurzem Tick neu vermessen.
    setTimeout(() => map.invalidateSize(), 200)

    let marker = null

    function writeInputs(lat, lon) {
      if (latInput) latInput.value = lat.toFixed(6)
      if (lonInput) lonInput.value = lon.toFixed(6)
      // Autosave anstoßen (lauscht auf input/change der Hidden-Felder).
      ;[latInput, lonInput].forEach((i) => {
        if (i) {
          i.dispatchEvent(new Event('input', { bubbles: true }))
          i.dispatchEvent(new Event('change', { bubbles: true }))
        }
      })
    }

    async function reverseFill(lat, lon) {
      try {
        const res = await fetch('/api/geo/reverse?lat=' + lat + '&lon=' + lon, {
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) return
        const data = await res.json()
        const label = data.result && data.result.label
        if (label && tatortInput) {
          tatortInput.value = label
          tatortInput.dispatchEvent(new Event('input', { bubbles: true }))
          tatortInput.dispatchEvent(new Event('change', { bubbles: true }))
        }
      } catch (_) {
        /* Photon nicht erreichbar – Marker bleibt, Adresse unverändert */
      }
    }

    function placeMarker(lat, lon) {
      const icon = thumbUrl ? imageIcon(thumbUrl) : null
      if (marker) {
        marker.setLatLng([lat, lon])
        if (icon) marker.setIcon(icon)
      } else {
        marker = L.marker([lat, lon], icon ? { draggable: true, icon } : { draggable: true }).addTo(map)
        marker.on('dragend', () => {
          const p = marker.getLatLng()
          writeInputs(p.lat, p.lng)
          // Adresse nur automatisch ermitteln, wenn das Feld noch leer ist. Sonst
          // würde das Feinjustieren des Markers (Hausnummer-Koordinate liegt oft
          // etwas neben der Straße) eine bereits gewählte Adresse mit Hausnummer
          // überschreiben. Position/Koordinaten werden trotzdem aktualisiert.
          if (tatortInput && !tatortInput.value.trim()) {
            reverseFill(p.lat, p.lng)
          }
        })
      }
    }

    // Marker immer setzen: bei vorhandenem Standort an dessen Position, sonst auf
    // den Default (Frankfurt Hbf). Beim Default zusätzlich die Koordinaten in die
    // Hidden-Felder schreiben und die Adresse vorbelegen, damit der Entwurf einen
    // sinnvollen Standort hat, den der Nutzer nur noch verschieben/anpassen muss.
    placeMarker(initLat, initLon)
    if (!hasPoint) {
      writeInputs(initLat, initLon)
      if (tatortInput && !tatortInput.value.trim()) reverseFill(initLat, initLon)
    }

    // Adresse/Standort an anderer Stelle gewählt: Marker setzen + Karte zentrieren.
    document.addEventListener('address:selected', (e) => {
      const d = e.detail || {}
      const lat = num(d.lat)
      const lon = num(d.lon)
      if (lat === null || lon === null) return
      placeMarker(lat, lon)
      map.setView([lat, lon], Math.max(map.getZoom(), 16))
      writeInputs(lat, lon)
    })

    // Erstes Beweisfoto geändert/umsortiert (report-form.js) -> Marker-Icon aktualisieren.
    document.addEventListener('report:first-image', (e) => {
      thumbUrl = (e.detail && e.detail.url) || null
      if (marker) marker.setIcon(thumbUrl ? imageIcon(thumbUrl) : new L.Icon.Default())
    })
  })
})()
