// Tatort-Karte auf der Bearbeiten-Seite (/anzeige/:id/bearbeiten).
//
// Zeigt den Tatort als verschiebbaren Marker. Tiles kommen same-origin über
// /tiles/{z}/{x}/{y}.png (Proxy auf basemap.de, siehe src/routes/tiles.ts).
// Geocoding bleibt Sache von Photon (/api/geo/*): Beim Verschieben des Markers
// wird per Reverse-Geocoding die Adresse aktualisiert.
//
// Kopplung an die übrigen Skripte nur über das Custom-Event "address:selected"
// ({ lat, lon, label }), das Autocomplete/Standort/Foto dispatchen. So bleibt
// dieses Skript die einzige Stelle, die Leaflet kennt.
(function () {
  // Helfer (Icons, Koordinaten-Prüfung, Kacheln, Stadtgrenzen): map-common.js.
  const M = window.OWIA.map
  M.fixDefaultIcon()
  // Leere/0-Koordinaten zählen nicht: ein Entwurf ohne Tatort zentriert sonst
  // auf 0/0 statt auf den Stadtmittelpunkt.
  const num = M.coord
  // Marker als kleines Vorschaubild (erstes Beweisfoto) statt Standard-Pin.
  const imageIcon = (url) => M.photoIcon(url, { size: 48, border: '#0d6efd' })

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
    M.setupBaseMap(map, el)

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
        const result = await window.OWIA.reverseGeocode(lat, lon)
        const label = result && result.label
        if (label && tatortInput) {
          // Adresse (nächstgelegene Straße/Hausnummer) nur als Beschriftung setzen.
          // Der Marker bleibt bewusst dort, wo der Nutzer ihn abgelegt hat – die
          // gespeicherte Position (Hidden-Felder) ist der gezogene Punkt, nicht die
          // Adress-Koordinate.
          tatortInput.value = label
          tatortInput.dispatchEvent(new Event('input', { bubbles: true }))
          tatortInput.dispatchEvent(new Event('change', { bubbles: true }))
          // Adresse hat sich geändert (Marker verschoben) -> Stadt-Erkennung in
          // report-form.js neu anstoßen. Bewusst NICHT über 'address:selected',
          // damit die Karte nicht neu zentriert (der Marker bleibt, wo er ist).
          document.dispatchEvent(
            new CustomEvent('tatort:changed', {
              detail: { lat: lat, lon: lon, label: label, postcode: result.postcode, city: result.city },
            })
          )
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
          // Marker verschoben -> Adresse des Tatorts per Reverse-Geocoding
          // aktualisieren (und darüber die Stadt-Erkennung neu anstoßen).
          reverseFill(p.lat, p.lng)
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

    // Stadt im Dropdown gewechselt (report-form.js) -> Karte auf die neue Stadt
    // zentrieren, solange noch kein Tatort-Marker gesetzt ist (sonst nicht stören).
    document.addEventListener('city:changed', (e) => {
      const d = e.detail || {}
      const lat = num(d.lat)
      const lon = num(d.lon)
      if (lat === null || lon === null || marker) return
      map.setView([lat, lon], 13)
    })
  })
})()
