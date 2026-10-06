// Macht jedes <select class="form-select"> der Seite durchsuchbar: Das native
// Select bleibt (versteckt) im Formular und ist weiterhin die Quelle der
// Wahrheit – Werte, Formular-Absenden und change-Handler der übrigen Scripts
// funktionieren unverändert. Davor sitzt ein Textfeld: Tippen filtert die
// Optionen, Pfeiltasten/Enter wählen, Escape bricht ab.
//
// Optionen werden bei jedem Öffnen frisch aus dem <select> gelesen, damit
// dynamisch befüllte Listen (Sammelbearbeitung, „In Entwurf verschieben")
// ohne Nacharbeit funktionieren. Neue Selects (Dialoge) erfasst ein
// MutationObserver. Ausnahme: <select data-native> bzw. multiple/size>1.
// Wer value per Script setzt, sollte danach ein change-Event auslösen
// (oder window.searchableSelect.sync(select) aufrufen).
;(function () {
  var seq = 0

  function norm(s) {
    return String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss')
  }

  function enhance(select) {
    if (select._ss || select.multiple || select.size > 1 || select.hasAttribute('data-native')) return
    var id = 'ss-' + ++seq
    var wrap = document.createElement('div')
    wrap.className = 'ss position-relative'
    var input = document.createElement('input')
    input.type = 'text'
    input.className = 'form-select ss-input' + (select.classList.contains('form-select-sm') ? ' form-select-sm' : '')
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-expanded', 'false')
    input.setAttribute('aria-controls', id)
    input.setAttribute('autocomplete', 'off')
    input.setAttribute('spellcheck', 'false')
    var label = select.getAttribute('aria-label') || (select.labels && select.labels[0] && select.labels[0].textContent.trim())
    if (label) input.setAttribute('aria-label', label)
    // Ein <label for=...> soll künftig das Suchfeld fokussieren.
    if (select.id) {
      input.id = select.id + '-search'
      if (select.labels) Array.prototype.forEach.call(select.labels, function (l) { if (l.htmlFor === select.id) l.htmlFor = input.id })
    }
    var menu = document.createElement('div')
    menu.id = id
    menu.className = 'list-group shadow-sm ss-menu'
    menu.setAttribute('role', 'listbox')
    menu.hidden = true

    select.parentNode.insertBefore(wrap, select)
    wrap.appendChild(select)
    wrap.appendChild(input)
    wrap.appendChild(menu)
    select.classList.add('ss-native')
    select.tabIndex = -1
    // Breitenvorgaben (w-auto, flex) des Selects an den Wrapper weitergeben.
    ;['w-auto', 'flex-fill', 'flex-grow-1'].forEach(function (c) { if (select.classList.contains(c)) wrap.classList.add(c) })

    var items = []
    var active = -1

    function selectedText() {
      var o = select.options[select.selectedIndex]
      return o ? o.textContent.trim() : ''
    }
    function sync() {
      input.value = selectedText()
      input.disabled = select.disabled
      wrap.hidden = select.hidden
      input.placeholder = selectedText() || 'Auswählen …'
    }
    function close() {
      menu.hidden = true
      input.setAttribute('aria-expanded', 'false')
      active = -1
      sync()
    }
    function choose(opt) {
      if (opt.disabled) return
      var changed = select.value !== opt.value
      select.value = opt.value
      close()
      if (changed) {
        select.dispatchEvent(new Event('input', { bubbles: true }))
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }
    function highlight() {
      items.forEach(function (it, i) { it.el.classList.toggle('active', i === active) })
      if (items[active]) items[active].el.scrollIntoView({ block: 'nearest' })
    }
    function render(query) {
      menu.replaceChildren()
      items = []
      var tokens = norm(query || '').split(/\s+/).filter(Boolean)
      Array.prototype.forEach.call(select.options, function (opt) {
        var text = opt.textContent.trim()
        if (tokens.length && !tokens.every(function (t) { return norm(text).indexOf(t) !== -1 })) return
        var b = document.createElement('button')
        b.type = 'button'
        b.className = 'list-group-item list-group-item-action py-2 small' + (opt.selected ? ' fw-semibold' : '')
        b.setAttribute('role', 'option')
        b.disabled = opt.disabled
        b.textContent = text || '—'
        b.addEventListener('mousedown', function (e) {
          e.preventDefault() // vor dem blur wählen
          choose(opt)
        })
        menu.appendChild(b)
        items.push({ el: b, opt: opt })
      })
      if (!items.length) {
        var none = document.createElement('div')
        none.className = 'list-group-item disabled small text-muted'
        none.textContent = 'Keine Treffer'
        menu.appendChild(none)
      }
      active = tokens.length && items.length ? 0 : items.findIndex(function (it) { return it.opt.selected })
      menu.hidden = false
      input.setAttribute('aria-expanded', 'true')
      highlight()
    }

    input.addEventListener('focus', function () {
      input.value = ''
      render('')
    })
    input.addEventListener('click', function () { if (menu.hidden) { input.value = ''; render('') } })
    input.addEventListener('input', function () { render(input.value) })
    input.addEventListener('blur', function () { setTimeout(close, 120) })
    input.addEventListener('keydown', function (e) {
      if (menu.hidden && (e.key === 'ArrowDown' || e.key === 'Enter')) {
        e.preventDefault()
        render('')
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        active = Math.min(active + 1, items.length - 1)
        highlight()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        active = Math.max(active - 1, 0)
        highlight()
      } else if (e.key === 'Enter') {
        e.preventDefault() // kein Formular-Absenden aus dem Suchfeld
        if (items[active]) choose(items[active].opt)
      } else if (e.key === 'Escape') {
        if (!menu.hidden) {
          e.preventDefault()
          e.stopPropagation() // Dialog nicht gleich mitschließen
          close()
        }
      } else if (e.key === 'Tab') {
        close()
      }
    })

    select.addEventListener('change', sync)
    // Optionen/Zustand per Script geändert (neu befüllt, disabled, hidden).
    new MutationObserver(sync).observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'hidden'] })
    select._ss = { sync: sync }
    sync()
  }

  function scan(root) {
    if (root.matches && root.matches('select.form-select')) enhance(root)
    if (root.querySelectorAll) root.querySelectorAll('select.form-select').forEach(enhance)
  }

  function start() {
    scan(document)
    new MutationObserver(function (records) {
      records.forEach(function (r) { r.addedNodes.forEach(function (n) { if (n.nodeType === 1) scan(n) }) })
    }).observe(document.body, { childList: true, subtree: true })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()

  window.searchableSelect = {
    sync: function (select) { if (select && select._ss) select._ss.sync() },
  }
})()
