// Foto-Import: zwei kleine Pakete überlappen lassen, damit Serververarbeitung
// nicht jede nächste Übertragung aufhält. Erst nach allen Antworten gruppieren.
;(function () {
  var input = document.getElementById('intake-files')
  var startBtn = document.getElementById('intake-start')
  if (!input || !startBtn) return

  // Fotos je Request: Server-Wert (CHUNK_SIZE in routes/intake.ts) kommt als
  // data-chunk-size am Datei-Input (upload.ejs) – der Server weist größere Pakete ab.
  var CHUNK_SIZE = Number(input.getAttribute('data-chunk-size')) || 5
  var CONCURRENCY = 2
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

  // Kamera-Direkteinstieg (verstecktes Input mit capture, upload.ejs): frische
  // Aufnahmen zur bestehenden Auswahl im Haupt-Input HINZUFÜGEN, damit sich
  // mehrere Kamera-Runden und Galerie-Auswahl kombinieren lassen.
  var cameraInput = document.getElementById('intake-camera')
  var cameraBtn = document.getElementById('intake-camera-btn')
  if (cameraInput && cameraBtn) {
    cameraBtn.addEventListener('click', function () { cameraInput.click() })
    cameraInput.addEventListener('change', function () {
      if (!cameraInput.files || !cameraInput.files.length) return
      var dt = new DataTransfer()
      Array.prototype.forEach.call(input.files || [], function (f) { dt.items.add(f) })
      Array.prototype.forEach.call(cameraInput.files, function (f) { dt.items.add(f) })
      input.files = dt.files
      cameraInput.value = ''
      input.dispatchEvent(new Event('change'))
    })
  }

  function showErrors(list) {
    errorsBox.innerHTML = list.map(function (e) { return '<div>' + window.OWIA.escapeHtml(e) + '</div>' }).join('')
    errorsBox.classList.remove('d-none')
  }
  function hideErrors() {
    errorsBox.classList.add('d-none')
    errorsBox.innerHTML = ''
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

  // Solange der Upload läuft, warnt der Browser beim Schließen/Verlassen der Seite.
  var uploading = false
  window.addEventListener('beforeunload', function (e) {
    if (!uploading) return
    e.preventDefault()
    e.returnValue = '' // Chrome/Firefox zeigen dann den Standard-Bestätigungsdialog
  })

  function currentSpeed(uploadedBytes) {
    var now = Date.now()
    speedSamples.push({ t: now, bytes: uploadedBytes })
    while (speedSamples.length > 2 && now - speedSamples[0].t > 4000) speedSamples.shift()
    var first = speedSamples[0]
    var dt = (now - first.t) / 1000
    return dt > 0.3 ? (uploadedBytes - first.bytes) / dt : 0
  }

  function setProgress(doneFiles, totalFiles, uploadedBytes, totalBytes, withGps, withTime, savedFiles, processing) {
    var pct = totalBytes ? Math.round((uploadedBytes / totalBytes) * 100) : 0
    bar.style.width = pct + '%'
    bar.textContent = pct + '%'

    var speed = currentSpeed(uploadedBytes)
    var parts = [
      'Bearbeitet: ' + Math.min(doneFiles, totalFiles) + ' / ' + totalFiles + ' Fotos',
      fmtBytes(uploadedBytes) + ' von ' + fmtBytes(totalBytes),
    ]
    if (speed > 1024) {
      parts.push(fmtBytes(speed) + '/s')
      var eta = fmtEta((totalBytes - uploadedBytes) / speed)
      if (eta) parts.push('noch ' + eta)
    }
    progressText.textContent = parts.join(' · ')
    stats.textContent = (savedFiles || 0) + ' gespeichert · ' + withGps + ' mit GPS · ' + withTime + ' mit Aufnahmezeit' + (processing ? ' · Server verarbeitet ' + processing + ' Paket(e)' : '')
  }

  // XHR statt fetch: nur so gibt es Upload-Progress-Events (Bytes im Flug).
  function uploadChunk(batchId, files, attempt, onProgress, onStage) {
    return new Promise(function (resolve, reject) {
      var fd = new FormData()
      files.forEach(function (f) { fd.append('bilder', f, f.name) })
      var xhr = new XMLHttpRequest()
      xhr.open('POST', '/import/' + batchId + '/photos')
      xhr.responseType = 'json'
      xhr.timeout = 10 * 60 * 1000
      onStage('upload')
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) onProgress(e.loaded, e.total)
      }
      xhr.upload.onload = function () { onProgress(1, 1); onStage('processing') }
      xhr.onload = function () {
        var response = xhr.response
        if (xhr.status >= 200 && xhr.status < 300 && response && Array.isArray(response.photos)) resolve(response)
        else if (xhr.status === 413 && response) resolve(response)
        else {
          var message = response && response.error || (xhr.status === 401 || xhr.status === 403 || xhr.status === 200 ? 'Bitte erneut anmelden.' : 'Upload fehlgeschlagen (HTTP ' + xhr.status + ').')
          fail(new Error(message), xhr.status === 429 || xhr.status >= 500)
        }
      }
      xhr.onerror = function () { fail(new Error('Die Verbindung wurde unterbrochen.'), true) }
      xhr.ontimeout = function () { fail(new Error('Der Upload hat zu lange gedauert.'), true) }
      xhr.onabort = function () { reject(new Error('Upload abgebrochen.')) }
      function fail(err, retryable) {
        if (retryable && attempt < 1) {
          onStage('retry')
          setTimeout(function () { uploadChunk(batchId, files, attempt + 1, onProgress, onStage).then(resolve, reject) }, 1000)
        } else reject(err)
      }
      xhr.send(fd)
    })
  }

  startBtn.addEventListener('click', async function () {
    if (uploading) return
    var files = Array.prototype.slice.call(input.files || [])
    if (!files.length) return
    hideErrors()
    progress.querySelectorAll('[data-finish-upload]').forEach(function (button) { button.remove() })
    picker.classList.add('d-none')
    progress.classList.remove('d-none')
    uploading = true
    var allErrors = []
    var allSkipped = []
    var done = 0
    var saved = 0
    var withGps = 0
    var withTime = 0
    var batchId
    // Große Dateien vorher ausschließen: Ein 413 darf nicht die übrigen Fotos
    // desselben Pakets unbemerkt verwerfen.
    var validFiles = files.filter(function (file) {
      if (file.size > 20 * 1024 * 1024) {
        allErrors.push(file.name + ': Bild zu groß (max. 20 MB).')
        done++
        return false
      }
      return true
    })
    var chunks = []
    for (var i = 0; i < validFiles.length; i += CHUNK_SIZE) {
      var chunkFiles = validFiles.slice(i, i + CHUNK_SIZE)
      chunks.push({ files: chunkFiles, bytes: chunkFiles.reduce(function (sum, file) { return sum + file.size }, 0), transferred: 0, stage: 'waiting' })
    }
    var totalBytes = validFiles.reduce(function (sum, file) { return sum + file.size }, 0)
    speedSamples = []
    function updateProgress() {
      var transferred = chunks.reduce(function (sum, chunk) { return sum + chunk.transferred }, 0)
      var processing = chunks.filter(function (chunk) { return chunk.stage === 'processing' }).length
      setProgress(done, files.length, transferred, totalBytes, withGps, withTime, saved, processing)
    }
    updateProgress()
    // Auch während CPU-Verarbeitung und Wartezeiten bleibt die Anzeige aktuell.
    var timer = setInterval(updateProgress, 500)
    try {
      if (!validFiles.length) throw new Error('Keine hochladbaren Fotos ausgewählt.')
      var batchResponse = await fetch('/import/batch', { method: 'POST' })
      if (!batchResponse.ok || batchResponse.redirected) throw new Error('Import konnte nicht angelegt werden. Bitte Anmeldung prüfen.')
      var batch = await batchResponse.json()
      if (!batch.batchId) throw new Error('Import konnte nicht angelegt werden.')
      batchId = batch.batchId
      var next = 0
      var stopped = false
      async function uploadNext() {
        while (!stopped && next < chunks.length) {
          var chunk = chunks[next++]
          try {
            var res = await uploadChunk(batchId, chunk.files, 0, function (loaded, total) {
              // Jeder Slot zählt eigene Bytes. Wiederholungen lassen den
              // Fortschritt nicht zurückspringen oder doppelt anwachsen.
              chunk.transferred = Math.max(chunk.transferred, chunk.bytes * (total ? Math.min(1, loaded / total) : 0))
              updateProgress()
            }, function (stage) { chunk.stage = stage; updateProgress() })
            ;(res.photos || []).forEach(function (photo) {
              saved++
              if (photo.hasGps) withGps++
              if (photo.capturedAt) withTime++
            })
            ;(res.errors || []).forEach(function (error) { allErrors.push(error) })
            ;(res.skipped || []).forEach(function (skip) { allSkipped.push(skip) })
            if (res.error) throw new Error(res.error)
            done += chunk.files.length
            chunk.transferred = chunk.bytes
            chunk.stage = 'done'
            updateProgress()
          } catch (error) {
            stopped = true
            chunk.stage = 'failed'
            throw error
          }
        }
      }
      // Keine neue Runde, Gruppierung oder Weiterleitung, solange ein anderer
      // Slot noch läuft – auch bei Fehlern warten wir seine Antwort ab.
      var workers = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, uploadNext))
      var failure = workers.find(function (result) { return result.status === 'rejected' })
      if (failure) throw failure.reason
      clearInterval(timer)
      if (allErrors.length) {
        showErrors(allErrors)
        progressText.textContent = 'Upload beendet: ' + saved + ' Fotos gespeichert. Bitte die Fehler prüfen.'
        var finishBtn = document.createElement('button')
        finishBtn.type = 'button'
        finishBtn.setAttribute('data-finish-upload', '')
        finishBtn.className = 'btn btn-primary mt-3'
        finishBtn.textContent = 'Gespeicherte Fotos gruppieren'
        progress.appendChild(finishBtn)
        uploading = false
        finishBtn.addEventListener('click', async function () {
          finishBtn.disabled = true
          uploading = true
          try { await finishBatch() }
          catch (error) { showErrors(allErrors.concat(error.message)); finishBtn.disabled = false; uploading = false }
        })
      } else await finishBatch()
      async function finishBatch() {
        progressText.textContent = 'Übertragung abgeschlossen. Die Verarbeitung läuft im Hintergrund …'
        var response = await fetch('/import/' + batchId + '/finish', { method: 'POST' })
        if (response.redirected) throw new Error('Bitte erneut anmelden.')
        var data = await response.json()
        if (!response.ok || !data.redirect) throw new Error(data.error || 'Gruppierung fehlgeschlagen.')
        uploading = false
        location.href = data.redirect + (allSkipped.length ? '?uebersprungen=' + allSkipped.length : '')
      }
    } catch (error) {
      clearInterval(timer)
      uploading = false
      allErrors.push(error.message || 'Upload fehlgeschlagen.')
      if (allSkipped.length) allErrors.push(allSkipped.length + ' Fotos wurden als bereits hochgeladen übersprungen.')
      if (batchId) allErrors.push('Bereits gespeicherte Fotos bleiben erhalten. Öffne „Bisherige Importe“, um sie zu gruppieren.')
      showErrors(allErrors)
      progress.classList.add('d-none')
      picker.classList.remove('d-none')
    }
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
