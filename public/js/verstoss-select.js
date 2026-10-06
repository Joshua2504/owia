// Durchsuchbare Verstoß-Auswahl. Ersetzt das große <select> durch ein Suchfeld
// mit Dropdown: „Häufig verwendete" Verstöße oben, darunter der ganze amtliche
// Tatbestandskatalog (durchsuchbar). Der gewählte Text landet im versteckten Feld
// name="verstoss_art"; input/change darauf lösen das Autosave (report-form.js) aus.
//
// Markup (siehe reports/edit.ejs):
//   <div data-verstoss-select class="position-relative">
//     <input type="hidden" name="verstoss_art" ...>
//     <input type="text" data-verstoss-input ...>
//     <script type="application/json" data-verstoss-data>{ haeufig:[], alle:[] }</script>
//   </div>
//
// Ohne eingebettete Daten (Anzeigen-Liste, ein Feld pro Zeile) initialisiert
// report-inline.js die Felder selbst: window.verstossSelect.init(root, data).
// Das Suchfeld darf dort ein <textarea> sein (lange Tatbestände umbrechen).
(function () {
  const MAX_RESULTS = 50

  // Suche unabhängig von Groß/Klein, Umlauten und ß ("fussganger" -> "Fußgänger").
  function norm(s) {
    return String(s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Diakritika (ä->a, é->e …) entfernen
      .replace(/ß/g, 'ss')
  }

  // Normalisierter Katalog einmal pro Datenobjekt – in der Liste teilen sich
  // hunderte Felder denselben Katalog.
  const prepared = new WeakMap()
  function prepare(data) {
    let p = prepared.get(data)
    if (!p) {
      const alle = Array.isArray(data.alle) ? data.alle : []
      const haeufig = Array.isArray(data.haeufig) ? data.haeufig : []
      p = { alle, haeufig, haeufigSet: new Set(haeufig), normAlle: alle.map((t) => ({ text: t, n: norm(t) })) }
      prepared.set(data, p)
    }
    return p
  }

  function initOne(root, givenData) {
    const hidden = root.querySelector('input[type="hidden"]')
    const input = root.querySelector('[data-verstoss-input]')
    const dataEl = root.querySelector('[data-verstoss-data]')
    if (!hidden || !input || root.dataset.verstossReady) return
    if (!givenData && !dataEl) return

    let data = givenData
    if (!data) {
      try {
        data = JSON.parse(dataEl.textContent)
      } catch (_) {
        return
      }
    }
    root.dataset.verstossReady = '1'
    const { alle, haeufig, haeufigSet, normAlle } = prepare(data)

    const menu = document.createElement('div')
    menu.className = 'list-group shadow-sm'
    menu.style.cssText =
      'position:absolute;top:100%;left:0;right:0;z-index:1050;max-height:340px;' +
      'overflow-y:auto;display:none;'
    root.appendChild(menu)

    let buttons = [] // aktuell wählbare Einträge (für Tastatur-Navigation)
    let active = -1
    // Browse-Modus (ohne Suche) zeigt den ganzen Katalog – inkrementell gerendert,
    // damit der Browser beim Öffnen nicht kurz ruckelt. browseRest = noch nicht
    // gerenderte Einträge, die beim Scrollen ans Ende nachgeladen werden.
    const BROWSE_BATCH = 40
    let browseRest = []

    function appendBrowseBatch() {
      browseRest.splice(0, BROWSE_BATCH).forEach(addItem)
    }

    function committed() {
      return hidden.value || ''
    }

    // Bei bereits getroffener Auswahl (Feldtext == gespeicherter Wert) im
    // „Browse"-Modus die Häufig-Liste zeigen, statt nach dem ganzen Text zu filtern.
    function effectiveQuery() {
      const v = input.value.trim()
      return v && v === committed() ? '' : v
    }

    function close() {
      menu.style.display = 'none'
      menu.innerHTML = ''
      buttons = []
      active = -1
      input.setAttribute('aria-expanded', 'false')
    }

    function choose(text) {
      hidden.value = text
      input.value = text
      // Autosave (report-form.js) hört auf input/change des versteckten Feldes.
      hidden.dispatchEvent(new Event('input', { bubbles: true }))
      hidden.dispatchEvent(new Event('change', { bubbles: true }))
      close()
      input.focus()
    }

    function addHeader(label) {
      const h = document.createElement('div')
      h.className = 'list-group-item disabled py-1 small fw-semibold text-muted'
      h.textContent = label
      menu.appendChild(h)
    }

    function addItem(text) {
      const btn = document.createElement('button')
      btn.type = 'button'
      const isSel = text === committed()
      btn.className = 'list-group-item list-group-item-action small py-2' + (isSel ? ' active' : '')
      btn.textContent = text
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault() // vor dem blur wählen
        choose(text)
      })
      menu.appendChild(btn)
      buttons.push(btn)
    }

    function highlight() {
      buttons.forEach((b, i) => b.classList.toggle('active', i === active))
      if (active >= 0 && buttons[active]) {
        buttons[active].scrollIntoView({ block: 'nearest' })
      }
    }

    function render() {
      menu.innerHTML = ''
      buttons = []
      active = -1
      browseRest = []
      const q = effectiveQuery()

      if (!q) {
        // Ohne Suche: Häufige oben als Schnellzugriff, darunter der komplette
        // Katalog zum Durchscrollen. Große Liste inkrementell rendern (erste
        // Charge jetzt, Rest beim Scrollen) – sonst ruckelt das Öffnen kurz.
        if (haeufig.length) {
          addHeader('Häufig verwendet')
          haeufig.forEach(addItem)
        }
        addHeader('Alle Tatbestände')
        browseRest = alle.filter((t) => !haeufigSet.has(t))
        appendBrowseBatch()
      } else {
        const tokens = norm(q).split(/\s+/).filter(Boolean)
        const matches = (n) => tokens.every((t) => n.indexOf(t) !== -1)
        // Auch beim Suchen stehen die häufig genutzten Treffer oben (in ihrer
        // Häufigkeits-Reihenfolge), darunter die übrigen aus dem Katalog.
        const top = haeufig.filter((t) => matches(norm(t)))
        const hits = []
        let capped = false
        for (const item of normAlle) {
          if (haeufigSet.has(item.text) || !matches(item.n)) continue
          if (hits.length >= MAX_RESULTS) {
            capped = true
            break
          }
          hits.push(item.text)
        }
        if (!top.length && !hits.length) {
          const none = document.createElement('div')
          none.className = 'list-group-item disabled py-2 small text-muted'
          none.textContent = 'Keine Treffer für „' + q + '"'
          menu.appendChild(none)
        } else {
          if (top.length) {
            addHeader('Häufig verwendet')
            top.forEach(addItem)
          }
          if (hits.length) {
            addHeader((top.length ? 'Weitere Treffer' : 'Treffer') + (capped ? ' (Top ' + MAX_RESULTS + ' – bitte eingrenzen)' : ''))
            hits.forEach(addItem)
          }
        }
      }

      menu.scrollTop = 0
      menu.style.display = 'block'
      input.setAttribute('aria-expanded', 'true')
    }

    // Browse-Modus: beim Scrollen ans Ende die nächste Charge nachladen.
    menu.addEventListener('scroll', () => {
      if (!browseRest.length) return
      if (menu.scrollTop + menu.clientHeight >= menu.scrollHeight - 160) {
        appendBrowseBatch()
      }
    })

    input.addEventListener('focus', () => {
      input.select()
      render()
    })
    input.addEventListener('input', render)
    input.addEventListener('keydown', (e) => {
      if (menu.style.display === 'none') {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          render()
        }
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (active >= buttons.length - 1 && browseRest.length) appendBrowseBatch()
        active = Math.min(active + 1, buttons.length - 1)
        highlight()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        active = Math.max(active - 1, 0)
        highlight()
      } else if (e.key === 'Enter') {
        if (active >= 0 && buttons[active]) {
          e.preventDefault()
          choose(buttons[active].textContent)
        }
      } else if (e.key === 'Escape') {
        close()
      }
    })
    // Beim Verlassen schließen und das Feld auf die tatsächliche Auswahl zurück-
    // setzen (uncommitteten Suchtext verwerfen).
    input.addEventListener('blur', () =>
      setTimeout(() => {
        close()
        input.value = committed()
      }, 150)
    )
  }

  function initAll() {
    document.querySelectorAll('[data-verstoss-select]').forEach((root) => initOne(root))
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll)
  else initAll()
  window.verstossSelect = { init: initOne }
})()
