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

  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('tatort-map')
    if (!el || !window.L) return

    const latInput = document.querySelector('input[name="tatort_lat"]')
    const lonInput = document.querySelector('input[name="tatort_lon"]')
    const tatortInput = document.querySelector('#tatort')

    const startLat = num(el.dataset.lat)
    const startLon = num(el.dataset.lon)
    const centerLat = num(el.dataset.centerLat) || 50.1109
    const centerLon = num(el.dataset.centerLon) || 8.6821
    const hasPoint = startLat !== null && startLon !== null

    const map = L.map(el).setView(
      [hasPoint ? startLat : centerLat, hasPoint ? startLon : centerLon],
      hasPoint ? 16 : 13
    )
    L.tileLayer('/tiles/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap-Mitwirkende',
    }).addTo(map)

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
      if (marker) {
        marker.setLatLng([lat, lon])
      } else {
        marker = L.marker([lat, lon], { draggable: true }).addTo(map)
        marker.on('dragend', () => {
          const p = marker.getLatLng()
          writeInputs(p.lat, p.lng)
          reverseFill(p.lat, p.lng)
        })
      }
    }

    if (hasPoint) placeMarker(startLat, startLon)

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
  })
})()
