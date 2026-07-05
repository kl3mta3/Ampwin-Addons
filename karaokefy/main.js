// Karaokefy — Ampwin addon.
//
// Right-click a local track ▸ Karaokefy ▸ Make karaoke. In one window:
//   1. Demucs (fast htdemucs) splits the song into vocals/drums/bass/other.
//   2. The 3 non-vocal stems are summed into an INSTRUMENTAL (ampwin.stems.mix).
//   3. Synced lyrics are fetched online — the same instant get the app uses
//      (ampwin.lyrics.fetchOnline → LRCLIB).
//   4. The lyrics + .lrc are saved into the app's Karaoke downloads folder
//      (appdata) alongside the instrumental — never the source's folder.
// You get an instrumental karaoke track to sing over + the synced lyrics.
/* global ampwin */
;(() => {
  'use strict'

  const ADDON_ID = 'karaokefy'
  const TITLE = 'Karaokefy'
  const HF = 'https://huggingface.co/StemSplitio'
  // Fast single-file Demucs v4 — one pass yields all 4 stems.
  const PACK = {
    id: 'htdemucs',
    label: 'HTDemucs v4 (fast)',
    kind: 'single',
    sources: ['drums', 'bass', 'other', 'vocals'],
    files: [{ url: `${HF}/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx`, file: 'htdemucs_fp16weights.onnx' }]
  }
  const INSTRUMENTAL_STEMS = ['drums', 'bass', 'other']

  // GPU (DirectML) for the Demucs step — OFF by default (CPU is reliable).
  const useGpu = () => localStorage.getItem(ADDON_ID + ':useGpu') === 'on'
  const setUseGpu = (on) => localStorage.setItem(ADDON_ID + ':useGpu', on ? 'on' : 'off')
  const KARAOKE_DIR = 'Karaoke'

  const CSS = `
    * { margin: 0; box-sizing: border-box; user-select: none; font-family: 'Segoe UI', sans-serif; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #101318; color: #cfd4dd; }
    body { display: flex; flex-direction: column; }
    #bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
           background: linear-gradient(#20242c, #14171d); border-bottom: 1px solid #000; -webkit-app-region: drag; }
    #logo { font-size: 10px; font-weight: bold; letter-spacing: 2px; color: #ffcf3f; }
    #song { flex: 1; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #9aa1ac; }
    button { -webkit-app-region: no-drag; background: #1d222b; color: #cfd4dd; border: 1px solid #000;
             border-radius: 3px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
    button:hover { background: #2a3140; }
    button:disabled { opacity: 0.5; cursor: default; }
    button.on { color: #3fdf6f; box-shadow: inset 0 0 6px rgba(63,223,111,.35); }
    #x:hover { background: #7f1f1f; }
    #main { flex: 1; overflow: hidden; padding: 12px; display: flex; flex-direction: column; }
    #status { font-size: 12px; color: #9aa1ac; margin-bottom: 6px; min-height: 16px; }
    #prow { display: flex; align-items: center; gap: 8px; }
    #start { background: #8a6d10; color: #fff8e6; font-weight: bold; padding: 6px 14px; }
    #start:hover { background: #a07f14; }
    #pbar { flex: 1; height: 14px; background: #0b0d10; border: 1px solid #000; border-radius: 3px; overflow: hidden; }
    #pfill { height: 100%; width: 0%; background: linear-gradient(90deg, #8a6d10, #ffcf3f); transition: width .2s; }
    #cancel { background: #3a1d1d; }
    #cancel:hover { background: #7f1f1f; }
    #transport { display: flex; align-items: center; gap: 10px; padding: 10px 4px; }
    #play { font-size: 16px; min-width: 44px; padding: 6px 0; }
    #seek { flex: 1; accent-color: #ffcf3f; -webkit-app-region: no-drag; }
    #time { font-family: Consolas, monospace; font-size: 12px; color: #ffcf3f; min-width: 96px; text-align: right; }
    #lyrics { flex: 1; overflow-y: auto; padding: 8px 4px; border-top: 1px solid #000; }
    .lyric { font-size: 14px; line-height: 1.5; padding: 3px 6px; color: #8b93a0; border-radius: 3px; }
    .lyric.active { color: #fff; background: rgba(255,207,63,.14); font-weight: bold; }
    #footer { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #000; background: #14171d; align-items: center; }
    #add-pl { color: #ffcf3f; font-weight: bold; }
    #rekar:hover { background: #2a3140; }
    .spacer { flex: 1; }
    .note { font-size: 11px; color: #6fd88f; }
    a.folder { color: #ffcf3f; font-size: 11px; cursor: pointer; -webkit-app-region: no-drag; }
  `

  const songName = (t) => ((t.artist ? t.artist + ' - ' : '') + t.title) || 'song'
  const fmtTime = (s) =>
    isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00'

  let win = null

  function openKaraokeWindow(track) {
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
        <span id="logo">🎤 KARAOKEFY</span>
        <span id="song"></span>
        <button id="settings" title="Settings">⚙</button>
        <button id="x" title="Close">×</button>
      </div>
      <div id="main">
        <div id="status">ready</div>
        <div id="prow">
          <button id="start" title="Split, mix an instrumental, and transcribe the lyrics">▶ Make karaoke</button>
          <div id="pbar" hidden><div id="pfill"></div></div>
          <button id="cancel" hidden title="Stop">cancel</button>
        </div>
        <div id="transport" hidden>
          <button id="play" title="Play the instrumental">▶</button>
          <input id="seek" type="range" min="0" max="1000" value="0" />
          <span id="time">0:00 / 0:00</span>
        </div>
        <div id="lyrics"></div>
      </div>
      <div id="footer" hidden>
        <button id="rekar" title="Run the whole karaoke process again from scratch">↻ Re-karaokefy</button>
        <span class="note" id="lrc-note"></span>
        <span class="spacer"></span>
        <a class="folder" id="open-folder">karaoke folder</a>
        <button id="add-pl" title="Save the instrumental and add it to your playlist">➕ Add to playlist</button>
        <button id="dl-mp3">Instrumental MP3</button>
        <button id="dl-wav">WAV</button>
        <button id="dl-flac">FLAC</button>
      </div>`

    const $ = (id) => doc.getElementById(id)
    $('song').textContent = songName(track)
    $('x').addEventListener('click', () => win.close())
    $('settings').addEventListener('click', openSettingsWindow)
    $('open-folder').addEventListener('click', () => ampwin.stems.openFolder(KARAOKE_DIR))
    $('start').addEventListener('click', () => void run())
    $('status').textContent = 'ready — adjust ⚙ settings if you like, then press Make karaoke.'

    const stemsJob = track.path + '::' + PACK.id
    let running = false
    let cancelled = false
    let instrumental = null // { path, url } — the cached mix used for preview
    let karaokePath = '' // saved "<song> (karaoke).mp3" in downloads/Karaoke
    let lines = []
    let audio = null
    let offStems = null

    const safeName = (s) => (s || 'song').replace(/[<>:"/\\|?*]/g, '_')

    const setStatus = (text, pct) => {
      if (win.closed) return
      $('status').textContent = text
      if (pct != null) $('pfill').style.width = pct + '%'
    }

    function addLyricEl(line) {
      const d = doc.createElement('div')
      d.className = 'lyric'
      d.dataset.ms = String(line.timeMs ?? 0)
      d.textContent = line.text
      $('lyrics').appendChild(d)
      $('lyrics').scrollTop = $('lyrics').scrollHeight
    }

    async function run() {
      if (running) return
      running = true
      cancelled = false
      lines = []
      instrumental = null
      karaokePath = ''
      stopPlayback()
      $('lyrics').textContent = ''
      $('transport').hidden = true
      $('footer').hidden = true
      $('start').hidden = true
      $('pbar').hidden = false
      $('cancel').hidden = false
      $('cancel').disabled = false
      $('cancel').textContent = 'cancel'

      // ---- 1. Demucs split -------------------------------------------------
      offStems = ampwin.stems.on('progress', (key, p) => {
        if (key !== stemsJob) return
        if (p.detail && /GPU error/i.test(p.detail) && useGpu()) setUseGpu(false)
        const labels = { download: 'downloading model (one-time)', decode: 'decoding audio', separate: 'separating vocals', finalize: 'writing stems' }
        setStatus(`1/3 ${labels[p.phase] || p.phase}… ${p.percent}%`, p.percent * 0.5)
      })
      let stems
      try {
        setStatus('1/3 preparing…', 0)
        stems = await ampwin.stems.separate(track, PACK, { useGpu: useGpu(), force: false, jobKey: stemsJob })
      } catch (err) {
        return fail(err)
      } finally {
        offStems?.()
        offStems = null
      }
      if (cancelled) return fail(new Error('cancelled'))

      // ---- 2. Mix the instrumental ----------------------------------------
      try {
        setStatus('2/3 mixing instrumental…', 55)
        const paths = INSTRUMENTAL_STEMS.map((s) => stems.stems[s].path)
        instrumental = await ampwin.stems.mix(paths, songName(track) + ' (instrumental)')
      } catch (err) {
        return fail(err)
      }
      if (cancelled) return fail(new Error('cancelled'))

      // ---- 3. Lyrics: fetch online (the same instant get the app uses) -----
      setStatus('3/3 looking up synced lyrics online…', 85)
      let online = null
      try {
        online = await ampwin.lyrics.fetchOnline(track)
      } catch (e) {
        /* offline / miss — karaoke still works without lyrics */
      }
      if (cancelled) return fail(new Error('cancelled'))

      if (online && online.synced && online.lines.length) {
        lines = online.lines
        $('lyrics').textContent = ''
        for (const l of lines) addLyricEl(l)
        setStatus('3/3 found synced lyrics ✓', 90)
      } else {
        lines = []
        setStatus('3/3 no synced lyrics found', 90)
      }

      // ---- 4. Save the KARAOKE track (+ its .lrc sidecar) to appdata -------
      // This is when the karaoke file is created: "<song> (karaoke).mp3" plus a
      // matching "<song> (karaoke).lrc" right beside it, in downloads/Karaoke.
      // "Add to playlist" then just adds this already-made file.
      try {
        setStatus('saving karaoke track…', 95)
        const name = safeName(songName(track) + ' (karaoke)')
        karaokePath = await ampwin.stems.export(instrumental.path, 'mp3', songName(track), name, KARAOKE_DIR)
        if (lines.length) await ampwin.lyrics.writeSidecar(karaokePath, lines) // "<...> (karaoke).lrc"
      } catch (err) {
        /* non-fatal — window still works, Add-to-playlist will report if empty */
      }
      if (cancelled) return fail(new Error('cancelled'))

      finishUp(lines.length > 0)
    }

    function fail(err) {
      const msg = (err.message || String(err)).replace(/^Error invoking.*?: Error: /, '')
      setStatus(cancelled || /cancel/i.test(msg) ? '■ cancelled — press Make karaoke to try again' : '⚠ ' + msg, 0)
      $('pbar').hidden = true
      $('cancel').hidden = true
      $('start').hidden = false
      running = false
    }

    function finishUp(hasLyrics) {
      running = false
      $('cancel').hidden = true
      $('pbar').style.width = '100%'
      setStatus(`✓ karaoke ready — ${lines.length} lyric lines`, 100)
      // instrumental player
      audio = doc.createElement('audio')
      audio.preload = 'auto'
      audio.src = instrumental.url
      audio.addEventListener('timeupdate', onTime)
      audio.addEventListener('ended', () => {
        playing = false
        $('play').textContent = '▶'
      })
      audio.addEventListener('loadedmetadata', () => {
        $('time').textContent = `0:00 / ${fmtTime(audio.duration)}`
      })
      $('transport').hidden = false
      $('footer').hidden = false
      $('lrc-note').textContent = karaokePath
        ? hasLyrics
          ? '✓ karaoke track + synced .lrc saved to the Karaoke folder'
          : '✓ karaoke track saved (no synced lyrics found for this song)'
        : hasLyrics
          ? '✓ synced lyrics found'
          : 'no synced lyrics found for this song'
    }

    // ---- instrumental playback + synced lyric highlight --------------------
    let playing = false
    let seeking = false
    let activeEl = null

    function stopPlayback() {
      if (audio) {
        try {
          audio.pause()
          audio.src = ''
        } catch (e) {
          /* ignore */
        }
      }
      audio = null
      playing = false
    }

    function onTime() {
      if (win.closed || seeking || !audio) return
      const d = audio.duration
      $('time').textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(d)}`
      if (d > 0) $('seek').value = Math.round((audio.currentTime / d) * 1000)
      highlight(audio.currentTime * 1000)
    }

    function highlight(ms) {
      const els = $('lyrics').children
      let target = null
      for (const el of els) {
        if (Number(el.dataset.ms) <= ms) target = el
        else break
      }
      if (target === activeEl) return
      if (activeEl) activeEl.classList.remove('active')
      activeEl = target
      if (activeEl) {
        activeEl.classList.add('active')
        activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }

    $('play').addEventListener('click', () => {
      if (!audio) return
      if (playing) {
        audio.pause()
        playing = false
        $('play').textContent = '▶'
      } else {
        void audio.play().catch(() => {})
        playing = true
        $('play').textContent = '⏸'
      }
    })
    $('seek').addEventListener('pointerdown', () => (seeking = true))
    $('seek').addEventListener('change', () => {
      if (audio && isFinite(audio.duration)) audio.currentTime = ($('seek').value / 1000) * audio.duration
      seeking = false
    })

    $('cancel').addEventListener('click', () => {
      cancelled = true
      $('cancel').disabled = true
      $('cancel').textContent = 'cancelling…'
      setStatus('cancelling…', null)
      ampwin.stems.cancel(stemsJob)
    })

    // Instrumental downloads: "<song> (instrumental).<fmt>" — just the audio.
    async function exportInstrumental(btn, fmt) {
      if (!instrumental) return
      const old = btn.textContent
      btn.disabled = true
      btn.textContent = '…'
      try {
        const name = safeName(songName(track) + ' (instrumental)')
        await ampwin.stems.export(instrumental.path, fmt, songName(track), name, KARAOKE_DIR)
        btn.textContent = '✓'
        setStatus(`saved ${name}.${fmt} → downloads/Karaoke`, null)
      } catch (err) {
        btn.textContent = old
        setStatus('⚠ export failed: ' + (err.message || err), null)
      }
      setTimeout(() => {
        btn.textContent = old
        btn.disabled = false
      }, 1500)
    }
    $('dl-mp3').addEventListener('click', (e) => exportInstrumental(e.target, 'mp3'))
    $('dl-wav').addEventListener('click', (e) => exportInstrumental(e.target, 'wav'))
    $('dl-flac').addEventListener('click', (e) => exportInstrumental(e.target, 'flac'))

    // The karaoke track (+ its .lrc) was already created during "Make karaoke";
    // this just adds that file to the playlist.
    async function addToPlaylist(btn) {
      if (!karaokePath) return
      const old = btn.textContent
      btn.disabled = true
      btn.textContent = 'adding…'
      try {
        await ampwin.playlist.addPaths([karaokePath])
        btn.textContent = '✓ added'
        setStatus(lines.length ? 'added the karaoke track (with .lrc lyrics) to your playlist' : 'added the karaoke track to your playlist', null)
      } catch (err) {
        btn.textContent = old
        setStatus('⚠ add to playlist failed: ' + (err.message || err), null)
      }
      setTimeout(() => {
        btn.textContent = old
        btn.disabled = false
      }, 1800)
    }
    $('add-pl').addEventListener('click', (e) => addToPlaylist(e.target))
    $('rekar').addEventListener('click', () => void run())

    win.addEventListener('unload', () => {
      stopPlayback()
      ampwin.stems.cancel(stemsJob)
      offStems?.()
    })
    // Window opens idle — user reviews ⚙ settings, then presses Make karaoke.
  }

  function openSettingsWindow() {
    const sw = window.open('about:blank', 'ampwin-addon-' + ADDON_ID + '-settings')
    if (!sw) return
    const doc = sw.document
    doc.title = TITLE + ' settings'
    const style = doc.createElement('style')
    style.textContent = CSS
    doc.head.appendChild(style)
    sw.resizeTo(440, 340)
    doc.body.innerHTML = `
      <div id="bar">
        <span id="logo">SETTINGS</span>
        <span id="song">${TITLE}</span>
        <button id="x" title="Close">×</button>
      </div>
      <div id="main">
        <label style="display:flex;gap:8px;align-items:center;font-size:13px;-webkit-app-region:no-drag;cursor:pointer">
          <input type="checkbox" id="gpu" /> Use GPU (DirectML) for the split — experimental
        </label>
        <div style="font-size:11px;color:#9aa1ac;margin:6px 0 14px">
          Off by default. CPU is reliable; DirectML is a speedup on well-supported
          cards but unstable on brand-new GPUs (falls back to CPU automatically).
        </div>
        <div style="font-size:11px;color:#9aa1ac;margin:0 0 14px">
          Lyrics are fetched online (LRCLIB) and saved with the instrumental in the
          Karaoke downloads folder.
        </div>
        <button id="stems-folder">open karaoke download folder…</button>
      </div>`
    const $ = (id) => doc.getElementById(id)
    $('x').addEventListener('click', () => sw.close())
    const gpu = $('gpu')
    gpu.checked = useGpu()
    gpu.addEventListener('change', () => setUseGpu(gpu.checked))
    $('stems-folder').addEventListener('click', () => ampwin.stems.openFolder(KARAOKE_DIR))
  }

  ampwin.menus.registerTrackMenu({
    label: '🎤 Karaokefy',
    items: [{ label: 'Make karaoke', action: (track) => openKaraokeWindow(track) }]
  })
})()
