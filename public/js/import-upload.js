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

  // --- Fortschritt: Prozent nach Bytes, Geschwindigkeit als gleitendes
  // Fenster über die letzten Sekunden, Restzeit aus verbleibenden Bytes. ---

  function fmtBytes(b) {
    if (b >= 1024 * 1024 * 1024) return (b / (1024 * 1024 * 1024)).toFixed(1).replace('.', ',') + ' GB'
    if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB'
    return Math.max(1, Math.round(b / 1024)) + ' KB'
  }
  function fmtEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return ''
    if (seconds < 60) return '~' + Math.max(1, Math.round(seconds)) + ' s'
    return '~' + Math.floor(seconds / 60) + ':' + String(Math.round(seconds % 60)).padStart(2, '0') + ' min'
  }

  var speedSamples = [] // { t, bytes } – Fenster für die Momentan-Geschwindigkeit

  function currentSpeed(uploadedBytes) {
    var now = Date.now()
    speedSamples.push({ t: now, bytes: uploadedBytes })
    while (speedSamples.length > 2 && now - speedSamples[0].t > 4000) speedSamples.shift()
    var first = speedSamples[0]
    var dt = (now - first.t) / 1000
    return dt > 0.3 ? (uploadedBytes - first.bytes) / dt : 0
  }

  function setProgress(doneFiles, totalFiles, uploadedBytes, totalBytes, withGps, withTime) {
    var pct = totalBytes ? Math.round((uploadedBytes / totalBytes) * 100) : 0
    bar.style.width = pct + '%'
    bar.textContent = pct + '%'

    var speed = currentSpeed(uploadedBytes)
    var parts = [
      'Foto ' + Math.min(doneFiles, totalFiles) + ' / ' + totalFiles,
      fmtBytes(uploadedBytes) + ' von ' + fmtBytes(totalBytes),
    ]
    if (speed > 1024) {
      parts.push(fmtBytes(speed) + '/s')
      var eta = fmtEta((totalBytes - uploadedBytes) / speed)
      if (eta) parts.push('noch ' + eta)
    }
    progressText.textContent = parts.join(' · ')
    stats.textContent = withGps + ' mit GPS-Position · ' + withTime + ' mit Aufnahmezeit'
  }

  // XHR statt fetch: nur so gibt es Upload-Progress-Events (Bytes im Flug).
  function uploadChunk(batchId, files, attempt, onProgress) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData()
      files.forEach(function (f) { fd.append('bilder', f, f.name) })

      var xhr = new XMLHttpRequest()
      xhr.open('POST', '/import/' + batchId + '/photos')
      xhr.responseType = 'json'
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) onProgress(e.loaded, e.total)
      }
      xhr.onload = function () {
        // 413 (zu groß) liefert wie die anderen Antworten JSON mit error-Feld.
        if (xhr.status && (xhr.status < 400 || xhr.status === 413)) resolve(xhr.response || {})
        else fail(new Error('http ' + xhr.status))
      }
      xhr.onerror = function () { fail(new Error('network')) }
      xhr.ontimeout = function () { fail(new Error('timeout')) }

      function fail(err) {
        // Ein Retry pro Chunk bei Netzwerkfehlern.
        if (attempt < 1) uploadChunk(batchId, files, attempt + 1, onProgress).then(resolve, reject)
        else reject(err)
      }

      xhr.send(fd)
    })
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
    var totalBytes = files.reduce(function (sum, f) { return sum + (f.size || 0) }, 0)
    var completedBytes = 0 // Bytes fertig hochgeladener Chunks
    speedSamples = []
    setProgress(0, files.length, 0, totalBytes, 0, 0)

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
          var chunkBytes = chunk.reduce(function (sum, f) { return sum + (f.size || 0) }, 0)
          chain = chain.then(function () {
            return uploadChunk(batchId, chunk, 0, function (loaded, total) {
              // loaded enthält Multipart-Overhead – auf die Dateigröße normieren.
              var frac = total ? Math.min(1, loaded / total) : 0
              setProgress(done, files.length, completedBytes + chunkBytes * frac, totalBytes, withGps, withTime)
            }).then(function (res) {
              ;(res.photos || []).forEach(function (p) {
                if (p.hasGps) withGps++
                if (p.capturedAt) withTime++
              })
              ;(res.errors || []).forEach(function (e) { allErrors.push(e) })
              if (res.error) allErrors.push(res.error)
              done += chunk.length
              completedBytes += chunkBytes
              setProgress(done, files.length, completedBytes, totalBytes, withGps, withTime)
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
