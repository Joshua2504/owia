// Foto-Import: viele Dateien in kleinen Chunks sequenziell hochladen (bleibt
// unter dem serverseitigen Multipart-Limit), dann Gruppierung anstoßen.
;(function () {
  var input = document.getElementById('intake-files')
  var startBtn = document.getElementById('intake-start')
  if (!input || !startBtn) return

  var CHUNK_SIZE = window.INTAKE_CHUNK_SIZE || 5
  var SOFT_CAP = 120

  var picker = document.getElementById('intake-picker')
  var progress = document.getElementById('intake-progress')
  var bar = document.getElementById('intake-progress-bar')
  var progressText = document.getElementById('intake-progress-text')
  var stats = document.getElementById('intake-stats')
  var errorsBox = document.getElementById('intake-errors')

  input.addEventListener('change', function () {
    var n = input.files ? input.files.length : 0
    startBtn.disabled = n === 0
    if (n > SOFT_CAP) {
      showErrors(['Mehr als ' + SOFT_CAP + ' Fotos ausgewählt – der Upload kann eine Weile dauern.'])
    } else {
      hideErrors()
    }
  })

  function showErrors(list) {
    errorsBox.innerHTML = list.map(function (e) { return '<div>' + escapeHtml(e) + '</div>' }).join('')
    errorsBox.classList.remove('d-none')
  }
  function hideErrors() {
    errorsBox.classList.add('d-none')
    errorsBox.innerHTML = ''
  }
  function escapeHtml(s) {
    var div = document.createElement('div')
    div.textContent = s
    return div.innerHTML
  }

  function setProgress(done, total, withGps, withTime) {
    var pct = total ? Math.round((done / total) * 100) : 0
    bar.style.width = pct + '%'
    bar.textContent = pct + '%'
    progressText.textContent = 'Foto ' + Math.min(done, total) + ' / ' + total + ' hochgeladen'
    stats.textContent = withGps + ' mit GPS-Position · ' + withTime + ' mit Aufnahmezeit'
  }

  function uploadChunk(batchId, files, attempt) {
    var fd = new FormData()
    files.forEach(function (f) { fd.append('bilder', f, f.name) })
    return fetch('/import/' + batchId + '/photos', { method: 'POST', body: fd }).then(
      function (res) {
        if (!res.ok && res.status !== 413) throw new Error('http ' + res.status)
        return res.json()
      },
      function (err) {
        // Ein Retry pro Chunk bei Netzwerkfehlern.
        if (attempt < 1) return uploadChunk(batchId, files, attempt + 1)
        throw err
      }
    )
  }

  startBtn.addEventListener('click', function () {
    var files = Array.prototype.slice.call(input.files || [])
    if (!files.length) return
    hideErrors()
    picker.classList.add('d-none')
    progress.classList.remove('d-none')

    var allErrors = []
    var done = 0
    var withGps = 0
    var withTime = 0
    setProgress(0, files.length, 0, 0)

    fetch('/import/batch', { method: 'POST' })
      .then(function (r) {
        if (!r.ok) throw new Error('batch')
        return r.json()
      })
      .then(function (data) {
        var batchId = data.batchId
        var chunks = []
        for (var i = 0; i < files.length; i += CHUNK_SIZE) chunks.push(files.slice(i, i + CHUNK_SIZE))

        var chain = Promise.resolve()
        chunks.forEach(function (chunk) {
          chain = chain.then(function () {
            return uploadChunk(batchId, chunk, 0).then(function (res) {
              ;(res.photos || []).forEach(function (p) {
                if (p.hasGps) withGps++
                if (p.capturedAt) withTime++
              })
              ;(res.errors || []).forEach(function (e) { allErrors.push(e) })
              if (res.error) allErrors.push(res.error)
              done += chunk.length
              setProgress(done, files.length, withGps, withTime)
            })
          })
        })

        return chain.then(function () {
          progressText.textContent = 'Gruppiere Fotos …'
          bar.style.width = '100%'
          return fetch('/import/' + batchId + '/finish', { method: 'POST' })
        })
      })
      .then(function (res) { return res.json() })
      .then(function (data) {
        if (allErrors.length) showErrors(allErrors)
        if (data.redirect) {
          location.href = data.redirect
        } else {
          throw new Error(data.error || 'finish')
        }
      })
      .catch(function () {
        allErrors.push('Upload fehlgeschlagen – bitte erneut versuchen. Bereits hochgeladene Fotos findest du unter „Bisherige Importe".')
        showErrors(allErrors)
        progress.classList.add('d-none')
        picker.classList.remove('d-none')
      })
  })

  // Buttons in der Batch-Liste ("Bisherige Importe").
  document.querySelectorAll('.intake-discard').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (!confirm('Diesen Import samt hochgeladener Fotos verwerfen?')) return
      fetch('/import/' + btn.getAttribute('data-batch') + '/discard', { method: 'POST' })
        .then(function () { location.reload() })
    })
  })
  document.querySelectorAll('.intake-finish-open').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.disabled = true
      fetch('/import/' + btn.getAttribute('data-batch') + '/finish', { method: 'POST' })
        .then(function (r) { return r.json() })
        .then(function (d) {
          if (d.redirect) location.href = d.redirect
          else location.reload()
        })
    })
  })
})()
