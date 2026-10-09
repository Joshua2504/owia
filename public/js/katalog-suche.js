// Bußgeldkatalog (/bussgeldkatalog-parken): Zeilen live filtern. Ohne JS
// bleibt die vollständige Tabelle sichtbar (SEO + Barrierefreiheit).
(function () {
  const input = document.querySelector('[data-katalog-suche]')
  if (!input) return
  const info = document.querySelector('[data-katalog-treffer]')
  const gruppen = Array.from(document.querySelectorAll('[data-katalog-gruppe]'))
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ')
  const zeilen = gruppen.flatMap((g) =>
    Array.from(g.querySelectorAll('[data-katalog-zeile]')).map((tr) => ({ tr, g, text: norm(tr.textContent || '') })))

  const filtern = OWIA.debounce(() => {
    const woerter = norm(input.value.trim()).split(' ').filter(Boolean)
    let treffer = 0
    const sichtbar = new Set()
    for (const z of zeilen) {
      const ok = woerter.every((w) => z.text.includes(w))
      z.tr.hidden = !ok
      if (ok) { treffer++; sichtbar.add(z.g) }
    }
    for (const g of gruppen) g.hidden = !sichtbar.has(g)
    info.textContent = woerter.length ? `${treffer} Treffer` : ''
  }, 120)
  input.addEventListener('input', filtern)
})()
