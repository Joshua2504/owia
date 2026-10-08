// Adress-Autovervollständigung über /api/geo/search (Photon-Proxy).
// Aktiviert sich auf allen Feldern mit [data-address-autocomplete].
//
//   data-fill="full"            -> ganze Adresse ins Feld (z.B. Tatort)
//   data-fill="street"          -> nur "Straße Hausnr." ins Feld (z.B. Einstellungen)
//   data-target-plz="#plz"      -> bei Auswahl PLZ in dieses Feld
//   data-target-hausnummer="#nr" -> (mit fill=street) Hausnummer getrennt in dieses Feld
//   data-target-ort="#ort"      -> bei Auswahl Ort in dieses Feld
//   data-geo-scope="ffm"        -> Treffer auf Frankfurt am Main begrenzen
(function () {
  const MIN_CHARS = 3
  const DEBOUNCE_MS = 250

  function fill(selector, value) {
    if (!selector) return
    const el = document.querySelector(selector)
    if (el && value != null && value !== '') el.value = value
  }

  function initOne(input) {
    if (input.dataset.acReady) return
    input.dataset.acReady = '1'
    input.setAttribute('autocomplete', 'off')

    const wrapper = document.createElement('div')
    wrapper.className = 'position-relative address-ac'
    input.parentNode.insertBefore(wrapper, input)
    wrapper.appendChild(input)

    const menu = document.createElement('div')
    menu.className = 'list-group address-ac-menu shadow-sm'
    menu.style.display = 'none'
    wrapper.appendChild(menu)

    let items = []
    let active = -1

    function close() {
      menu.style.display = 'none'
      menu.innerHTML = ''
      items = []
      active = -1
    }

    function choose(s) {
      if ((input.dataset.fill || 'full') === 'street' && input.dataset.targetHausnummer) {
        input.value = s.street || ''
        fill(input.dataset.targetHausnummer, s.housenumber)
      } else if ((input.dataset.fill || 'full') === 'street') {
        input.value = [s.street, s.housenumber].filter(Boolean).join(' ')
      } else {
        input.value = s.label
      }
      fill(input.dataset.targetPlz, s.postcode)
      fill(input.dataset.targetOrt, s.city)
      // Koordinaten an die Karte melden (falls vorhanden) – siehe report-map.js.
      // postcode/city zusätzlich, damit report-form.js das zuständige Amt erkennt.
      // Zusätzlich am Feld selbst (bubbelt): mehrere Tatort-Felder auf einer
      // Seite (Inline-Bearbeitung der Anzeigen-Liste, report-inline.js).
      input.dispatchEvent(new CustomEvent('address:chosen', { bubbles: true, detail: s }))
      if (Number.isFinite(s.lat) && Number.isFinite(s.lon) && !input.hasAttribute('data-ac-local')) {
        document.dispatchEvent(
          new CustomEvent('address:selected', {
            detail: { lat: s.lat, lon: s.lon, label: s.label, postcode: s.postcode, city: s.city },
          })
        )
      }
      close()
      input.focus()
    }

    function render() {
      if (!items.length) {
        close()
        return
      }
      menu.innerHTML = ''
      items.forEach((s, i) => {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className =
          'list-group-item list-group-item-action' + (i === active ? ' active' : '')
        btn.textContent = s.label
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault()
          choose(s)
        })
        menu.appendChild(btn)
      })
      menu.style.display = 'block'
    }

    const search = window.OWIA.debounce(async function () {
      const q = input.value.trim()
      if (q.length < MIN_CHARS) {
        close()
        return
      }
      try {
        let endpoint = '/api/geo/search?q=' + encodeURIComponent(q)
        if (input.dataset.geoScope) {
          endpoint += '&scope=' + encodeURIComponent(input.dataset.geoScope)
        }
        const res = await fetch(endpoint, {
          headers: { Accept: 'application/json' },
        })
        if (!res.ok) return close()
        const data = await res.json()
        items = data.results || []
        active = -1
        render()
      } catch (_) {
        close()
      }
    }, DEBOUNCE_MS)

    // Nur bei echter Tastatureingabe suchen. Programmatisch gesetzte Werte (Marker
    // verschoben/eingerastet, Standort oder Foto übernommen) dispatchen zwar ein
    // input-Event fürs Autosave, sollen aber die Vorschlagsliste NICHT öffnen.
    input.addEventListener('input', (e) => {
      if (e.isTrusted) search()
    })
    input.addEventListener('keydown', (e) => {
      if (menu.style.display === 'none') return
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        active = Math.min(active + 1, items.length - 1)
        render()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        active = Math.max(active - 1, 0)
        render()
      } else if (e.key === 'Enter') {
        // Ohne Pfeil-Auswahl gilt der erste Vorschlag.
        const it = items[active >= 0 ? active : 0]
        if (it) {
          e.preventDefault()
          choose(it)
        }
      } else if (e.key === 'Tab') {
        // Wie Enter, Fokus wandert danach normal weiter.
        const it = items[active >= 0 ? active : 0]
        if (it) choose(it)
      } else if (e.key === 'Escape') {
        close()
      }
    })
    input.addEventListener('blur', () => setTimeout(close, 150))
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-address-autocomplete]').forEach(initOne)
  })
  // Für nachträglich eingefügte Felder (z.B. neu geladene Listenzeilen).
  window.addressAutocomplete = { init: initOne }
})()
