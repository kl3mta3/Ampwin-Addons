// Demucs 6s Stems — Ampwin addon.
//
// Adds "Demucs 6s ▸ Get stems" to the right-click menu of local tracks.
// Separation runs in Ampwin's stems engine (HTDemucs ONNX via onnxruntime,
// CPU or DirectML GPU); this addon is the UI: a stems window with synced
// preview + per-stem mutes, WAV/FLAC/MP3 downloads, Restem, download-all, and
// a settings window. The 6-source model (~130 MB) downloads on first use and
// splits Guitar and Piano out separately in addition to the classic four.
/* global ampwin */
;(() => {
  'use strict'

  // ---- addon config (differs from demucs-v4 only in this block) ------------
  const ADDON_ID = 'demucs-6s'
  const MENU_LABEL = '🎚 Demucs 6s'
  const TITLE = 'Demucs 6s stems'
  const STEM_LABELS = {
    drums: '🥁 Drums',
    bass: '🎸 Bass',
    other: '🎹 Other',
    vocals: '🎤 Vocals',
    guitar: '🎸 Guitar',
    piano: '🎹 Piano'
  }
  const HF = 'https://huggingface.co/StemSplitio'
  const PACK = {
    id: 'htdemucs-6s',
    label: 'HTDemucs 6s (6 sources)',
    kind: 'single',
    sources: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'],
    files: [
      {
        url: `${HF}/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx`,
        file: 'htdemucs_6s_fp16weights.onnx'
      }
    ]
  }
  // ---------------------------------------------------------------------------

  // Default OFF: CPU is reliable and reasonably fast (~a few seconds per chunk).
  // GPU (DirectML) is an opt-in speedup — great on stable cards, but slow/
  // unstable on brand-new GPUs whose DirectML kernels aren't optimized yet.
  const useGpu = () => localStorage.getItem(ADDON_ID + ':useGpu') === 'on'
  const setUseGpu = (on) => localStorage.setItem(ADDON_ID + ':useGpu', on ? 'on' : 'off')

  const CSS = `
    * { margin: 0; box-sizing: border-box; user-select: none; font-family: 'Segoe UI', sans-serif; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #101318; color: #cfd4dd; }
    body { display: flex; flex-direction: column; }
    #bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
           background: linear-gradient(#20242c, #14171d); border-bottom: 1px solid #000;
           -webkit-app-region: drag; }
    #logo { font-size: 10px; font-weight: bold; letter-spacing: 2px; color: #3fdf6f; }
    #song { flex: 1; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #9aa1ac; }
    button { -webkit-app-region: no-drag; background: #1d222b; color: #cfd4dd; border: 1px solid #000;
             border-radius: 3px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
    button:hover { background: #2a3140; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.on { color: #3fdf6f; box-shadow: inset 0 0 6px rgba(63,223,111,.35); }
    #x:hover { background: #7f1f1f; }
    #main { flex: 1; overflow-y: auto; padding: 12px; }
    #status { font-size: 12px; color: #9aa1ac; margin-bottom: 6px; min-height: 16px; }
    #prow { display: flex; align-items: center; gap: 8px; }
    #pbar { flex: 1; height: 14px; background: #0b0d10; border: 1px solid #000; border-radius: 3px; overflow: hidden; }
    #pfill { height: 100%; width: 0%; background: linear-gradient(90deg, #1f7a3f, #3fdf6f); transition: width .2s; }
    #start { background: #1f7a3f; color: #eafff0; font-weight: bold; padding: 6px 14px; }
    #start:hover { background: #269150; }
    #cancel { background: #3a1d1d; }
    #cancel:hover { background: #7f1f1f; }
    #transport { display: flex; align-items: center; gap: 10px; padding: 10px 4px 14px; }
    #play { font-size: 16px; min-width: 44px; padding: 6px 0; }
    #seek { flex: 1; accent-color: #3fae66; -webkit-app-region: no-drag; }
    #time { font-family: Consolas, monospace; font-size: 12px; color: #6fd88f; min-width: 96px; text-align: right; }
    .stem { display: flex; align-items: center; gap: 10px; padding: 10px 8px; border-bottom: 1px solid #000; }
    .stem.muted .stem-name { opacity: 0.35; }
    .mute { min-width: 42px; }
    .stem-name { flex: 1; font-size: 13px; font-weight: bold; }
    .dl { display: flex; gap: 4px; }
    .dl button { min-width: 48px; }
    #footer { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #000; background: #14171d; align-items: center; }
    .spacer { flex: 1; }
    a.folder { color: #3fdf6f; font-size: 11px; cursor: pointer; -webkit-app-region: no-drag; }
  `

  function songName(track) {
    return ((track.artist ? track.artist + ' - ' : '') + track.title) || 'song'
  }

  let win = null

  function openStemsWindow(track) {
    if (win && !win.closed) {
      win.focus()
      return
    }
    win = window.open('about:blank', 'ampwin-addon-' + ADDON_ID)
    if (!win) return
    const doc = win.document
    doc.title = TITLE
    const style = doc.createElement('style')
    style.textContent = CSS
    doc.head.appendChild(style)
    doc.body.innerHTML = `
      <div id="bar">
        <span id="logo">${TITLE.toUpperCase()}</span>
        <span id="song"></span>
        <button id="settings" title="Settings">⚙</button>
        <button id="x" title="Close">×</button>
      </div>
      <div id="main">
        <div id="status">ready</div>
        <div id="prow">
          <button id="start" title="Begin separating this song">▶ Start separation</button>
          <div id="pbar" hidden><div id="pfill"></div></div>
          <button id="cancel" hidden title="Stop this separation">cancel</button>
        </div>
        <div id="transport" hidden>
          <button id="play" title="Play all stems in sync">▶</button>
          <input id="seek" type="range" min="0" max="1000" value="0" />
          <span id="time">0:00 / 0:00</span>
        </div>
        <div id="stems"></div>
      </div>
      <div id="footer" hidden>
        <button id="restem" title="Run the separation again from scratch">↻ Restem</button>
        <span class="spacer"></span>
        <a class="folder" id="open-folder">open stems folder</a>
        <button id="all-mp3">Download all (MP3)</button>
        <button id="all-wav">Download all (WAV)</button>
        <button id="all-flac">Download all (FLAC)</button>
      </div>`

    const $ = (id) => doc.getElementById(id)
    $('song').textContent = songName(track)
    $('x').addEventListener('click', () => win.close())
    $('settings').addEventListener('click', openSettingsWindow)
    $('open-folder').addEventListener('click', () => ampwin.stems.openFolder())
    $('start').addEventListener('click', () => void run(false))
    $('status').textContent = 'ready — adjust ⚙ settings if you like, then press Start.'

    const jobKey = track.path + '::' + PACK.id
    let result = null
    let offProgress = null
    let running = false

    function setStatus(text, pct) {
      if (win.closed) return
      $('status').textContent = text
      if (pct != null) $('pfill').style.width = pct + '%'
    }

    let cancelled = false
    let gpuAutoDisabled = false

    async function run(force) {
      if (running) return
      running = true
      cancelled = false
      stopPreview()
      $('footer').hidden = true
      $('transport').hidden = true
      $('stems').textContent = ''
      $('prow').style.display = ''
      $('start').hidden = true
      $('pbar').hidden = false
      $('cancel').hidden = false
      $('cancel').disabled = false
      $('cancel').textContent = 'cancel'
      setStatus('preparing…', 0)
      offProgress = ampwin.stems.on('progress', (key, p) => {
        if (key !== jobKey) return
        // A GPU we know fails on this card — stop retrying it next time.
        if (p.detail && /GPU error/i.test(p.detail) && useGpu()) {
          setUseGpu(false)
          gpuAutoDisabled = true
        }
        const labels = {
          download: 'downloading model (one-time)',
          decode: 'decoding audio',
          separate: 'separating',
          finalize: 'writing stems'
        }
        setStatus(`${labels[p.phase] || p.phase}… ${p.percent}%${p.detail ? ' — ' + p.detail : ''}`, p.percent)
      })
      try {
        result = await ampwin.stems.separate(track, PACK, { useGpu: useGpu(), force, jobKey })
        renderStems()
        const note = gpuAutoDisabled ? ' (GPU unsupported here — CPU from now on)' : ''
        setStatus(
          (result.fromCache && !force ? 'loaded from cache — previews below' : '✓ separation complete') + note,
          100
        )
        $('prow').style.display = 'none'
        $('footer').hidden = false
      } catch (err) {
        const msg = (err.message || String(err)).replace(/^Error invoking.*?: Error: /, '')
        setStatus(cancelled || /cancel/i.test(msg) ? '■ cancelled — press Start to try again' : '⚠ ' + msg, 0)
        // Return to the ready state so the user can adjust ⚙ and retry.
        $('pbar').hidden = true
        $('start').hidden = false
      }
      $('cancel').hidden = true
      offProgress?.()
      offProgress = null
      running = false
    }

    $('cancel').addEventListener('click', () => {
      cancelled = true
      $('cancel').disabled = true
      $('cancel').textContent = 'cancelling…'
      setStatus('cancelling…', null)
      ampwin.stems.cancel(jobKey)
    })

    // ---- synced preview: ONE transport drives every stem <audio> together;
    // per-stem mute buttons single instruments out (classic stem-player UX).
    let audios = []
    let playing = false
    let seeking = false

    const fmtTime = (s) =>
      isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00'

    function stopPreview() {
      for (const a of audios) {
        try {
          a.pause()
          a.src = ''
        } catch (e) {
          /* ignore */
        }
      }
      audios = []
      playing = false
    }

    function renderStems() {
      stopPreview()
      const box = $('stems')
      box.textContent = ''
      $('transport').hidden = false
      $('play').textContent = '▶'
      $('seek').value = 0

      for (const name of PACK.sources) {
        const info = result.stems[name]
        const audio = doc.createElement('audio')
        audio.preload = 'auto'
        audio.src = info.url
        audios.push(audio)

        const row = doc.createElement('div')
        row.className = 'stem'
        const mute = doc.createElement('button')
        mute.className = 'mute'
        mute.textContent = '🔊'
        mute.title = `Mute ${name}`
        mute.addEventListener('click', () => {
          audio.muted = !audio.muted
          mute.textContent = audio.muted ? '🔇' : '🔊'
          mute.classList.toggle('on', audio.muted)
          row.classList.toggle('muted', audio.muted)
        })
        const label = doc.createElement('div')
        label.className = 'stem-name'
        label.textContent = STEM_LABELS[name] || name
        const dl = doc.createElement('div')
        dl.className = 'dl'
        for (const fmt of ['wav', 'flac', 'mp3']) {
          const b = doc.createElement('button')
          b.textContent = fmt.toUpperCase()
          b.title = `Save ${name} as ${fmt.toUpperCase()}`
          b.addEventListener('click', () => exportOne(b, info.path, fmt, name))
          dl.appendChild(b)
        }
        row.append(mute, label, dl)
        box.appendChild(row)
      }

      // The first stem is the clock: it drives the seek bar and the end state.
      const master = audios[0]
      master.addEventListener('timeupdate', () => {
        if (win.closed || seeking) return
        const d = master.duration
        $('time').textContent = `${fmtTime(master.currentTime)} / ${fmtTime(d)}`
        if (d > 0) $('seek').value = Math.round((master.currentTime / d) * 1000)
      })
      master.addEventListener('ended', () => {
        playing = false
        $('play').textContent = '▶'
      })
      master.addEventListener('loadedmetadata', () => {
        $('time').textContent = `0:00 / ${fmtTime(master.duration)}`
      })
    }

    function syncTo(sec) {
      for (const a of audios) {
        try {
          a.currentTime = sec
        } catch (e) {
          /* not loaded yet */
        }
      }
    }

    $('play').addEventListener('click', () => {
      if (!audios.length) return
      if (playing) {
        for (const a of audios) a.pause()
        playing = false
        $('play').textContent = '▶'
      } else {
        // Re-align before starting so stems can never drift apart.
        syncTo(audios[0].currentTime)
        for (const a of audios) void a.play().catch(() => {})
        playing = true
        $('play').textContent = '⏸'
      }
    })
    $('seek').addEventListener('pointerdown', () => (seeking = true))
    $('seek').addEventListener('change', () => {
      const master = audios[0]
      if (master && isFinite(master.duration)) {
        syncTo(($('seek').value / 1000) * master.duration)
      }
      seeking = false
    })

    async function exportOne(btn, wavPath, fmt, stem) {
      const old = btn.textContent
      btn.disabled = true
      btn.textContent = '…'
      try {
        await ampwin.stems.export(wavPath, fmt, songName(track), stem)
        btn.textContent = '✓'
        setStatus(`saved ${stem}.${fmt} → downloads/Stems`, null)
      } catch (err) {
        btn.textContent = old
        setStatus('⚠ export failed: ' + (err.message || err), null)
      }
      setTimeout(() => {
        btn.textContent = old
        btn.disabled = false
      }, 1500)
    }

    async function exportAll(fmt) {
      if (!result) return
      for (const name of PACK.sources) {
        setStatus(`saving ${name}.${fmt}…`, null)
        try {
          await ampwin.stems.export(result.stems[name].path, fmt, songName(track), name)
        } catch (err) {
          setStatus('⚠ ' + (err.message || err), null)
          return
        }
      }
      setStatus(`✓ all stems saved as ${fmt.toUpperCase()} → downloads/Stems`, null)
      ampwin.stems.openFolder()
    }

    $('restem').addEventListener('click', () => run(true))
    $('all-mp3').addEventListener('click', () => exportAll('mp3'))
    $('all-wav').addEventListener('click', () => exportAll('wav'))
    $('all-flac').addEventListener('click', () => exportAll('flac'))

    win.addEventListener('unload', () => {
      stopPreview()
      ampwin.stems.cancel(jobKey)
      offProgress?.()
    })
    // Window opens idle — user reviews ⚙ settings, then presses Start to separate.
  }

  function openSettingsWindow() {
    const sw = window.open('about:blank', 'ampwin-addon-' + ADDON_ID + '-settings')
    if (!sw) return
    const doc = sw.document
    doc.title = TITLE + ' settings'
    const style = doc.createElement('style')
    style.textContent = CSS
    doc.head.appendChild(style)
    sw.resizeTo(420, 260)
    doc.body.innerHTML = `
      <div id="bar">
        <span id="logo">SETTINGS</span>
        <span id="song">${TITLE}</span>
        <button id="x" title="Close">×</button>
      </div>
      <div id="main">
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;-webkit-app-region:no-drag;cursor:pointer">
          <input type="checkbox" id="gpu" /> Use GPU (DirectML) — experimental
        </label>
        <div style="font-size:11px;color:#9aa1ac;margin:6px 0 14px">
          Off by default. CPU is reliable and reasonably fast. Turning this on
          uses your graphics card via DirectML — a big speedup on well-supported
          GPUs, but on brand-new cards (e.g. RTX 50-series) DirectML is currently
          slower than CPU and can crash mid-run; it falls back to CPU if so.
        </div>
        <button id="stems-folder">open stems download folder…</button>
        <div style="font-size:11px;color:#9aa1ac;margin-top:14px">
          Model: ${PACK.label} (${PACK.files.length} file${PACK.files.length > 1 ? 's' : ''}, downloads on first use)
        </div>
      </div>`
    const $ = (id) => doc.getElementById(id)
    $('x').addEventListener('click', () => sw.close())
    const gpu = $('gpu')
    gpu.checked = useGpu()
    gpu.addEventListener('change', () => setUseGpu(gpu.checked))
    $('stems-folder').addEventListener('click', () => ampwin.stems.openFolder())
  }

  ampwin.menus.registerTrackMenu({
    label: MENU_LABEL,
    items: [{ label: 'Get stems', action: (track) => openStemsWindow(track) }]
  })
})()
