/* global ampwin */
;(() => {
  'use strict'

  const ADDON_ID = 'plexify'
  const PRODUCT = 'Plexify'
  const VERSION = '1.2.1'
  const STORAGE = {
    clientId: `${ADDON_ID}:client-id`,
    userToken: `${ADDON_ID}:user-token`,
    privateJwk: `${ADDON_ID}:private-jwk`,
    keyId: `${ADDON_ID}:key-id`,
    serverId: `${ADDON_ID}:server-id`,
    videoQuality: `${ADDON_ID}:video-quality`
  }

  const state = {
    modalOpen: false,
    uiDoc: null,
    appWindow: null,
    overlay: null,
    observer: null,
    authWindow: null,
    authBusy: false,
    initializing: false,
    servers: [],
    server: null,
    libraries: [],
    sidebarCollapsed: false,
    librariesCollapsed: false,
    route: null,
    history: [],
    routeNonce: 0,
    contextMenu: null,
    viewMode: 'grid',
    videoQuality: localStorage.getItem(`${ADDON_ID}:video-quality`) || '720p',
    tvProviders: [],
    tvProvider: null,
    tvChannels: [],
    tvGuideData: {},
    tvDate: localDateKey(),
    tvLiveSession: null,
    playerErrorUnsub: null,
    playerTrackUnsub: null,
    tvNowTimer: null
  }

  const clientId = getOrCreate(STORAGE.clientId, () => crypto.randomUUID())

  function getOrCreate(key, create) {
    const old = localStorage.getItem(key)
    if (old) return old
    const value = create()
    localStorage.setItem(key, value)
    return value
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function localDateKey(date = new Date()) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  function plexHeaders(token, extra = {}) {
    return {
      Accept: 'application/json',
      'X-Plex-Client-Identifier': clientId,
      'X-Plex-Product': PRODUCT,
      'X-Plex-Version': VERSION,
      'X-Plex-Platform': 'Ampwin',
      'X-Plex-Device': 'Desktop',
      ...(token ? { 'X-Plex-Token': token } : {}),
      ...extra
    }
  }

  async function request(options) {
    if (!ampwin.network?.request) {
      throw new Error('Plexify requires an Ampwin build with network.request support')
    }
    return ampwin.network.request({ timeoutMs: 20_000, ...options })
  }

  async function requestJson(options) {
    const response = await request(options)
    if (!response.ok) {
      let detail = ''
      try {
        const parsed = JSON.parse(response.body)
        detail = parsed?.errors?.[0]?.message || parsed?.error || parsed?.message || ''
      } catch {
        detail = response.body?.slice(0, 180) || ''
      }
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    if (!response.body) return null
    try {
      return JSON.parse(response.body)
    } catch {
      throw new Error('Plex returned invalid JSON')
    }
  }

  function bytesToBase64Url(bytes) {
    let binary = ''
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
    for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i])
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
  }

  function textToBase64Url(value) {
    return bytesToBase64Url(new TextEncoder().encode(value))
  }

  async function ensureDeviceKey() {
    const saved = localStorage.getItem(STORAGE.privateJwk)
    const savedKid = localStorage.getItem(STORAGE.keyId)
    if (saved && savedKid) {
      const privateJwk = JSON.parse(saved)
      const privateKey = await crypto.subtle.importKey('jwk', privateJwk, { name: 'Ed25519' }, false, ['sign'])
      const publicJwk = { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, kid: savedKid, alg: 'EdDSA', use: 'sig' }
      return { privateKey, publicJwk, kid: savedKid }
    }

    const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const kid = crypto.randomUUID()
    privateJwk.kid = kid
    privateJwk.alg = 'EdDSA'
    privateJwk.use = 'sig'
    localStorage.setItem(STORAGE.privateJwk, JSON.stringify(privateJwk))
    localStorage.setItem(STORAGE.keyId, kid)
    return {
      privateKey: pair.privateKey,
      publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, kid, alg: 'EdDSA', use: 'sig' },
      kid
    }
  }

  async function signDeviceJwt(privateKey, kid, payload) {
    const header = { alg: 'EdDSA', typ: 'JWT', kid }
    const signingInput = `${textToBase64Url(JSON.stringify(header))}.${textToBase64Url(JSON.stringify(payload))}`
    const signature = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, new TextEncoder().encode(signingInput))
    return `${signingInput}.${bytesToBase64Url(signature)}`
  }

  async function createPin() {
    try {
      const device = await ensureDeviceKey()
      const pin = await requestJson({
        url: 'https://clients.plex.tv/api/v2/pins',
        method: 'POST',
        headers: plexHeaders(null, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ jwk: device.publicJwk, strong: true })
      })
      return { ...pin, mode: 'jwt', device }
    } catch (modernError) {
      const pin = await requestJson({
        url: 'https://plex.tv/api/v2/pins?strong=true',
        method: 'POST',
        headers: plexHeaders()
      })
      return { ...pin, mode: 'legacy', modernError }
    }
  }

  async function pollPin(pin, onStatus) {
    const deadline = Date.now() + 3 * 60_000
    let attempts = 0
    while (Date.now() < deadline) {
      await sleep(2000)
      attempts++
      onStatus?.(`Waiting for Plex authorization… ${attempts}`)
      const pinHost = pin.mode === 'jwt' ? 'clients.plex.tv' : 'plex.tv'
      let url = `https://${pinHost}/api/v2/pins/${encodeURIComponent(pin.id)}`
      if (pin.mode === 'jwt') {
        const now = Math.floor(Date.now() / 1000)
        const deviceJwt = await signDeviceJwt(pin.device.privateKey, pin.device.kid, {
          aud: 'plex.tv',
          iss: clientId,
          iat: now,
          exp: now + 300
        })
        url += `?deviceJWT=${encodeURIComponent(deviceJwt)}`
      }
      const result = await requestJson({ url, headers: plexHeaders() })
      const token = result?.authToken || result?.auth_token
      if (token) return token
      if (state.authWindow?.closed) throw new Error('Plex authorization window was closed')
    }
    throw new Error('Plex authorization timed out')
  }

  async function signIn() {
    if (state.authBusy) return
    state.authBusy = true
    const status = ui('login-status')
    const button = ui('login-button')
    if (button) button.disabled = true
    try {
      if (status) status.textContent = 'Creating a secure Plex authorization request…'
      const pin = await createPin()
      const authUrl =
        `https://app.plex.tv/auth#?clientID=${encodeURIComponent(clientId)}` +
        `&code=${encodeURIComponent(pin.code)}` +
        `&context%5Bdevice%5D%5Bproduct%5D=${encodeURIComponent(PRODUCT)}`
      state.authWindow = window.open(authUrl, 'ampwin-addon-plexify-auth')
      if (!state.authWindow) throw new Error('Ampwin could not open the Plex sign-in window')
      const token = await pollPin(pin, (message) => {
        if (status?.isConnected) status.textContent = message
      })
      localStorage.setItem(STORAGE.userToken, token)
      try { state.authWindow.close() } catch {}
      state.authWindow = null
      await initializeSession(true)
    } catch (error) {
      if (status?.isConnected) status.textContent = error?.message || String(error)
    } finally {
      state.authBusy = false
      if (button?.isConnected) button.disabled = false
    }
  }

  function signOut() {
    clearGuideNowTimer()
    stopLiveTVKeepalive(true)
    localStorage.removeItem(STORAGE.userToken)
    localStorage.removeItem(STORAGE.serverId)
    state.servers = []
    state.server = null
    state.libraries = []
    state.history = []
    state.route = null
    renderLogin()
  }

  function currentSkinDocument() {
    try {
      const frame = window.parent.document.querySelector('#skin-layer iframe')
      return frame?.contentDocument || null
    } catch {
      return null
    }
  }

  function installIntoSkin() {
    const doc = currentSkinDocument()
    if (!doc?.body) {
      installHostFallback()
      return
    }
    installLaunchButton(doc)
    if (doc.getElementById('plexify-launch')) removeHostFallback()
  }

  // Fallback for skins whose document cannot be extended. The shell overlay is
  // above every skin; pointer-events is restored only for this one button.
  function installHostFallback() {
    try {
      const host = window.parent.document
      const layer = host.getElementById('overlay-layer')
      if (!layer || host.getElementById('plexify-host-launch')) return
      const button = host.createElement('button')
      button.id = 'plexify-host-launch'
      button.textContent = 'Plexify'
      button.title = 'Browse and play your Plex libraries'
      Object.assign(button.style, {
        pointerEvents: 'auto',
        position: 'absolute',
        right: '8px',
        bottom: '44px',
        zIndex: '2147483000',
        padding: '4px 10px',
        background: 'linear-gradient(#2a2e37, #1a1d23)',
        color: '#c8ccd4',
        border: '1px solid #3a3f4b',
        borderRadius: '3px',
        font: '12px Segoe UI, sans-serif',
        cursor: 'pointer'
      })
      button.addEventListener('click', toggleModal)
      layer.appendChild(button)
    } catch (error) {
      console.error('Plexify could not install its fallback button', error)
    }
  }

  function removeHostFallback() {
    try { window.parent.document.getElementById('plexify-host-launch')?.remove() } catch {}
  }

  function installLaunchButton(doc) {
    if (doc.getElementById('plexify-launch')) return
    const button = doc.createElement('button')
    button.id = 'plexify-launch'
    button.textContent = 'Plexify'
    button.title = 'Browse and play your Plex libraries'
    button.addEventListener('click', toggleModal)

    const actions = doc.querySelector('#playlist-actions')
    if (actions) {
      const addons = actions.querySelector('#btn-addons')
      actions.insertBefore(button, addons || null)
      return
    }

    const footer = doc.querySelector('footer, .footer, [class*="footer"]')
    if (footer) {
      footer.appendChild(button)
      return
    }

    Object.assign(button.style, {
      position: 'fixed',
      right: '10px',
      bottom: '10px',
      zIndex: '2147483000',
      padding: '5px 10px',
      background: '#202630',
      color: '#d7dce5',
      border: '1px solid #526070',
      borderRadius: '4px',
      cursor: 'pointer'
    })
    doc.body.appendChild(button)
  }

  function toggleModal() {
    if (state.appWindow && !state.appWindow.closed) {
      state.appWindow.focus()
      return
    }

    const appWindow = window.open('about:blank', 'ampwin-addon-plexify')
    if (!appWindow) {
      console.error('Plexify could not open its addon window')
      return
    }

    state.modalOpen = true
    state.appWindow = appWindow
    appWindow.document.title = 'Plexify'
    appWindow.addEventListener('unload', () => {
      if (state.appWindow !== appWindow) return
      state.modalOpen = false
      state.appWindow = null
      state.overlay = null
      state.uiDoc = null
      state.contextMenu = null
    })
    mountModal(appWindow.document)
  }

  function closeModal() {
    const appWindow = state.appWindow
    state.modalOpen = false
    clearGuideNowTimer()
    removeContextMenu()
    state.overlay?.remove()
    state.overlay = null
    state.uiDoc = null
    state.appWindow = null
    if (appWindow && !appWindow.closed) appWindow.close()
  }

  const MODAL_CSS = `
    #plexify-modal, #plexify-modal * { box-sizing: border-box; }
    #plexify-modal { position: fixed; inset: 0; z-index: 2147483600; display: flex;
      flex-direction: column; color: var(--text, #d5dae3); background: rgba(4,6,9,.78);
      font-family: inherit, "Segoe UI", sans-serif; font-size: 12px; user-select: none; }
    #plexify-modal .px-window { margin: 0; min-height: 0; flex: 1; display: flex;
      flex-direction: column; overflow: hidden; background: var(--bg, #12161c);
      border: 1px solid var(--edge-hi, #4a5361); border-radius: 0;
      box-shadow: 0 18px 55px rgba(0,0,0,.65); }
    #plexify-modal .px-drag-top { height: 6px; flex: 0 0 6px; -webkit-app-region: drag;
      background: transparent; cursor: default; }
    #plexify-modal .px-header { height: 43px; flex: 0 0 43px; display: flex; align-items: center;
      -webkit-app-region: drag;
      gap: 7px; padding: 6px 8px; background: var(--bg-panel, #1b2028);
      border-bottom: 1px solid var(--edge-lo, #000); }
    #plexify-modal button, #plexify-modal select, #plexify-modal input { font: inherit; -webkit-app-region: no-drag; }
    #plexify-modal button { cursor: pointer; background: linear-gradient(#2a2e37, #1a1d23);
      color: #c8ccd4; border: 1px solid #000; border-top-color: #3a3f4b;
      border-left-color: #3a3f4b; border-radius: 2px; padding: 2px 8px;
      font-size: 12px; min-width: 26px; }
    #plexify-modal button:hover { background: linear-gradient(#343945, #22252d); }
    #plexify-modal button:active { background: #0a0c0e;
      border-top-color: #000; border-left-color: #000; }
    #plexify-modal .px-header button { line-height: 18px; }
    #plexify-modal .px-brand { color: #e5a00d; font-weight: 800; letter-spacing: .5px; }
    #plexify-modal .px-title { min-width: 90px; font-weight: 600; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    #plexify-modal .px-search { margin-left: auto; display: flex; gap: 4px; min-width: 180px; }
    #plexify-modal .px-search input { min-width: 0; width: 180px; padding: 4px 7px;
      color: var(--text, #d5dae3); background: var(--bg-inset, #090c10);
      border: 1px solid var(--edge-hi, #4a5361); border-radius: 3px; user-select: text; }
    #plexify-modal .px-body { min-height: 0; flex: 1; display: flex; }
    #plexify-modal .px-sidebar { width: 184px; flex: 0 0 184px; overflow: auto;
      background: color-mix(in srgb, var(--bg-panel, #1b2028) 92%, black);
      border-right: 1px solid var(--edge-lo, #000); transition: width .15s, flex-basis .15s; }
    #plexify-modal .px-sidebar.collapsed { width: 0; flex-basis: 0; overflow: hidden; border: 0; }
    #plexify-modal .px-server { padding: 9px 8px; border-bottom: 1px solid rgba(127,127,127,.16); }
    #plexify-modal .px-server select { width: 100%; min-width: 0; padding: 4px; color: inherit;
      background: var(--bg-inset, #090c10); border: 1px solid var(--edge-hi, #4a5361); }
    #plexify-modal .px-nav-button, #plexify-modal .px-library { width: 100%; display: flex;
      align-items: center; gap: 8px; padding: 8px 10px; color: inherit; background: transparent;
      border: 0; text-align: left; border-radius: 0; }
    #plexify-modal .px-nav-button:hover, #plexify-modal .px-library:hover { background: rgba(229,160,13,.14); }
    #plexify-modal .px-section-title { display: flex; align-items: center; padding: 10px 10px 5px;
      color: var(--text-dim, #8992a1); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
    #plexify-modal .px-section-title button { margin-left: auto; color: inherit; background: none;
      border: 0; padding: 0; min-width: 0; }
    #plexify-modal .px-main { position: relative; min-width: 0; min-height: 0; flex: 1;
      overflow: auto; padding: 12px 14px 24px; background: var(--bg, #12161c); }
    #plexify-modal .px-login, #plexify-modal .px-message { height: 100%; min-height: 260px;
      display: grid; place-items: center; text-align: center; }
    #plexify-modal .px-login-card { max-width: 400px; padding: 30px; background: var(--bg-panel, #1b2028);
      border: 1px solid var(--edge-hi, #4a5361); border-radius: 8px; }
    #plexify-modal .px-login-logo { color: #e5a00d; font-size: 25px; font-weight: 900; margin-bottom: 10px; }
    #plexify-modal .px-login-card p { margin: 8px 0 16px; color: var(--text-dim, #9aa2af); line-height: 1.5; }
    #plexify-modal .px-primary { padding: 7px 16px; color: #17130a; background: #e5a00d;
      border: 1px solid #ffd15c; border-radius: 4px; font-weight: 700; }
    #plexify-modal .px-nav-button, #plexify-modal .px-library,
    #plexify-modal .px-context button { background: transparent;
      border: 0; border-radius: 0; min-width: 0; }
    #plexify-modal .px-hub { margin-bottom: 20px; }
    #plexify-modal .px-hub h2 { margin: 0 0 9px; font-size: 15px; }
    #plexify-modal .px-row { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 7px; }
    #plexify-modal .px-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 13px; }
    #plexify-modal .px-card { position: relative; flex: 0 0 118px; min-width: 0; cursor: default; }
    #plexify-modal .px-grid .px-card { width: auto; }
    #plexify-modal .px-poster { position: relative; width: 100%; aspect-ratio: 2/3; overflow: hidden;
      border-radius: 5px; background: linear-gradient(145deg, #252c36, #0b0e12);
      border: 1px solid rgba(255,255,255,.08); }
    #plexify-modal .px-card[data-type="track"] .px-poster,
    #plexify-modal .px-card[data-type="album"] .px-poster,
    #plexify-modal .px-card[data-type="artist"] .px-poster { aspect-ratio: 1; }
    #plexify-modal .px-poster img { width: 100%; height: 100%; display: block; object-fit: cover; -webkit-user-drag: none; }
    #plexify-modal .px-card:hover .px-poster { border-color: #e5a00d; box-shadow: 0 0 0 1px #e5a00d; }
    #plexify-modal .px-card-title { margin-top: 5px; overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; font-weight: 600; }
    #plexify-modal .px-card-subtitle { color: var(--text-dim, #8992a1); overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }
    #plexify-modal .px-progress { position: absolute; left: 5px; right: 5px; bottom: 5px;
      height: 3px; background: rgba(0,0,0,.7); border-radius: 2px; overflow: hidden; }
    #plexify-modal .px-progress span { display: block; height: 100%; background: #e5a00d; }
    #plexify-modal .px-empty { padding: 45px 15px; text-align: center; color: var(--text-dim, #8992a1); }
    #plexify-modal .px-bulk-actions { display: flex; align-items: center; gap: 8px;
      margin: 0 0 12px; padding: 0 0 10px; border-bottom: 1px solid rgba(127,127,127,.16); }
    #plexify-modal .px-bulk-actions button { min-width: 0; padding: 5px 11px;
      color: #e5a00d; background: rgba(229,160,13,.13);
      border: 1px solid rgba(229,160,13,.35); border-radius: 3px; font-weight: 700; }
    #plexify-modal .px-bulk-actions button:hover { background: rgba(229,160,13,.25); }
    #plexify-modal .px-bulk-actions button:disabled { cursor: wait; opacity: .65; }
    #plexify-modal .px-context { position: fixed; z-index: 2147483640; min-width: 190px; max-width: 280px;
      padding: 5px; background: #171b22; border: 1px solid #566171; border-radius: 5px;
      box-shadow: 0 10px 30px rgba(0,0,0,.65); }
    #plexify-modal .px-context button { display: block; width: 100%; padding: 6px 8px; color: #dce1e9;
      background: transparent; border: 0; text-align: left; }
    #plexify-modal .px-context button:hover { background: rgba(229,160,13,.18); }
    #plexify-modal .px-context .px-context-label { padding: 6px 8px 3px; color: #8992a1;
      font-size: 10px; text-transform: uppercase; letter-spacing: .8px; }
    #plexify-modal .px-context hr { border: 0; border-top: 1px solid #343b46; }
    #plexify-modal .px-toast { position: absolute; right: 14px; bottom: 14px; max-width: 360px;
      padding: 8px 11px; color: #fff; background: rgba(12,15,19,.94); border: 1px solid #5f6977;
      border-radius: 5px; box-shadow: 0 6px 25px rgba(0,0,0,.5); }
    #plexify-modal .px-muted { color: var(--text-dim, #8992a1); }
    #plexify-modal #px-view-mode, #plexify-modal #px-quality { background: var(--bg-inset, #0a0c0e); color: var(--text, #c8ccd4);
      border: 1px solid var(--edge-hi, #3a3f4b); font-size: 11px; padding: 2px 4px;
      border-radius: 2px; max-width: 110px; }
    #plexify-modal .px-list { font-family: Consolas, 'Courier New', monospace; font-size: 11px; }
    #plexify-modal .px-list-row { display: flex; gap: 6px; padding: 2px 8px; cursor: default;
      white-space: nowrap; color: #1f7f3f; align-items: center; }
    #plexify-modal .px-list-row:nth-child(even) { background: rgba(255,255,255,.02); }
    #plexify-modal .px-list-row:hover { background: rgba(63,223,111,.08); }
    #plexify-modal .px-list-num { min-width: 30px; text-align: right; color: #7a8090; }
    #plexify-modal .px-list-name { flex: 1; overflow: hidden; text-overflow: ellipsis; }
    #plexify-modal .px-list-type { min-width: 55px; color: #7a8090; font-size: 10px;
      text-transform: uppercase; }
    #plexify-modal .px-list-dur { color: #7a8090; min-width: 42px; text-align: right; }
    #plexify-modal .px-list-row.px-list-playable { color: #3fdf6f; cursor: pointer; }
    #plexify-modal .px-list-row.px-list-container { color: #2d9f57; cursor: pointer; }
    #plexify-modal .px-list-row.px-list-container:hover,
    #plexify-modal .px-list-row.px-list-playable:hover { color: #5fff8f; }
    #plexify-modal .px-list-section { padding: 8px 8px 4px; color: #8992a1; font-size: 10px;
      text-transform: uppercase; letter-spacing: 1px; font-family: 'Segoe UI', sans-serif;
      border-bottom: 1px solid rgba(127,127,127,.12); }
    #plexify-modal .px-guide { position: relative; }
    #plexify-modal .px-guide-controls { display: flex; align-items: center; gap: 10px; padding: 0 0 12px; flex-wrap: wrap; }
    #plexify-modal .px-guide-controls select { background: var(--bg-inset, #0a0c0e); color: var(--text, #c8ccd4);
      border: 1px solid var(--edge-hi, #3a3f4b); font-size: 12px; padding: 4px 8px; border-radius: 3px; }
    #plexify-modal .px-guide-controls button { background: rgba(229,160,13,.15); color: #e5a00d;
      border: 1px solid rgba(229,160,13,.3); border-radius: 3px; padding: 4px 10px; font-size: 12px; min-width: 0; }
    #plexify-modal .px-guide-controls button:hover { background: rgba(229,160,13,.3); }
    #plexify-modal .px-guide-controls .px-guide-date { color: var(--text, #c8ccd4); font-weight: 600; font-size: 13px; }
    #plexify-modal .px-guide-channels { position: relative; overflow: auto; max-height: calc(100vh - 160px); border: 1px solid rgba(127,127,127,.15); border-radius: 5px; }
    #plexify-modal .px-guide-time-row { position: sticky; top: 0; z-index: 8; display: flex;
      height: 30px; min-height: 30px; color: #b9c8dc; background: #12171e;
      border-bottom: 1px solid rgba(127,127,127,.28); }
    #plexify-modal .px-guide-time-corner { position: sticky; left: 0; z-index: 10;
      width: 130px; flex: 0 0 130px; background: #12171e;
      border-right: 2px solid rgba(127,127,127,.42);
      box-shadow: 6px 0 10px rgba(0,0,0,.32); }
    #plexify-modal .px-guide-time-axis { position: relative; display: flex;
      height: 30px; flex: 0 0 auto; overflow: hidden; }
    #plexify-modal .px-guide-time-slot { position: relative; height: 30px;
      flex: 0 0 100px; padding: 7px 8px 0;
      border-left: 1px solid rgba(127,127,127,.22);
      font-size: 10px; white-space: nowrap; pointer-events: none; }
    #plexify-modal .px-guide-time-now { position: absolute; top: 0; bottom: 0; width: 3px;
      background: #fff; box-shadow: -1px 0 0 rgba(0,0,0,.8), 1px 0 0 rgba(0,0,0,.8);
      pointer-events: none; z-index: 9; }
    #plexify-modal .px-guide-time-now::before { content: ''; position: absolute; top: 0; left: 50%;
      transform: translateX(-50%); border-left: 6px solid transparent;
      border-right: 6px solid transparent; border-top: 8px solid #fff; }
    #plexify-modal .px-guide-ch-row { display: flex; min-height: 48px; border-bottom: 1px solid rgba(127,127,127,.1); }
    #plexify-modal .px-guide-ch-name { width: 130px; flex: 0 0 130px; display: flex; align-items: center;
      gap: 6px; padding: 4px 8px; background: #0d1117;
      border-right: 2px solid rgba(127,127,127,.42);
      box-shadow: 6px 0 10px rgba(0,0,0,.32);
      position: sticky; left: 0; z-index: 6; overflow: hidden;
      font-size: 11px; font-weight: 600; cursor: pointer; }
    #plexify-modal .px-guide-ch-name span { min-width: 0; overflow: hidden;
      text-overflow: ellipsis; white-space: nowrap; }
    #plexify-modal .px-guide-ch-name:hover { background: rgba(229,160,13,.12); }
    #plexify-modal .px-guide-ch-name img { width: 26px; height: 26px; border-radius: 3px; object-fit: contain;
      background: #000; flex-shrink: 0; }
    #plexify-modal .px-guide-programs { display: flex; flex: 0 0 auto; min-width: 0; overflow: visible; }
    #plexify-modal .px-guide-gap { flex: 0 0 auto; min-width: 0; border-right: 1px solid rgba(255,255,255,.035); }
    #plexify-modal .px-guide-prog { position: relative; z-index: 1; min-width: 0; padding: 4px 8px;
      color: inherit; background: transparent; border: 0; border-right: 1px solid rgba(127,127,127,.08);
      border-radius: 0; cursor: pointer; pointer-events: auto; display: flex; flex-direction: column;
      justify-content: center; overflow: hidden; text-align: left; transition: background .15s; }
    #plexify-modal .px-guide-prog:hover { background-color: rgba(229,160,13,.15); }
    #plexify-modal .px-guide-prog-title { position: relative; z-index: 2; font-size: 11px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; pointer-events: none; }
    #plexify-modal .px-guide-prog-time { position: relative; z-index: 2; font-size: 9px;
      color: var(--text-dim, #8992a1); white-space: nowrap; pointer-events: none; }
    #plexify-modal .px-guide-current-progress {
  position: absolute;
  inset: 0;
  pointer-events: none !important;
  z-index: 1;
  overflow: hidden;} 
  #plexify-modal .px-guide-current-fill {position: absolute; left: 0; top: 0;
  bottom: 0; width: 0; background: rgba(229,160,13,.22); border-bottom: 3px solid #e5a00d; pointer-events: none !important;}
  #plexify-modal .px-guide-current-line {
  position: absolute; top: 0; bottom: 0; left: 0; width: 4px; transform: translateX(-2px); background: #fff; box-shadow: -1px 0 0 rgba(0,0,0,.75),1px 0 0 rgba(0,0,0,.75); pointer-events: none !important;}
#plexify-modal .px-guide-current-line::before {
  content: ''; position: absolute;top: 0; left: 50%; transform: translate(-50%, 0); border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 7px solid #fff; pointer-events: none;}
#plexify-modal .px-guide-prog.px-airing {
  background-color: rgba(229,160,13,.08);}
#plexify-modal .px-guide-loading { padding: 30px; text-align: center; color: var(--text-dim, #8992a1); }`

  function mountModal(doc) {
    if (!doc?.body) return
    doc.documentElement.style.width = '100%'
    doc.documentElement.style.height = '100%'
    doc.documentElement.style.overflow = 'hidden'
    Object.assign(doc.body.style, { margin: '0', width: '100%', height: '100%', overflow: 'hidden', background: '#12161c' })
    doc.getElementById('plexify-modal')?.remove()
    let style = doc.getElementById('plexify-style')
    if (!style) {
      style = doc.createElement('style')
      style.id = 'plexify-style'
      style.textContent = MODAL_CSS
      doc.head.appendChild(style)
    }

    const overlay = doc.createElement('div')
    overlay.id = 'plexify-modal'
    overlay.innerHTML = `
      <div class="px-window" role="dialog" aria-label="Plexify">
        <div class="px-drag-top"></div>
        <div class="px-header">
          <button id="px-menu" title="Collapse navigation">☰</button>
          <button id="px-back" title="Back" disabled>←</button>
          <span class="px-brand">PLEXIFY</span>
          <span class="px-title" id="px-title">Home</span>
          <select id="px-view-mode" title="View mode">
            <option value="grid" selected>Thumbnails</option>
            <option value="list">List</option>
          </select>
          <select id="px-quality" title="Live TV quality. Library files use the original Plex source so seeking works.">
            <option value="original" selected>Direct</option>
            <option value="1080p">1080p</option>
            <option value="720p">720p</option>
            <option value="480p">480p</option>
            <option value="360p">360p</option>
          </select>
          <form class="px-search" id="px-search-form">
            <input id="px-search" type="search" placeholder="Search Plex" autocomplete="off" />
            <button type="submit">Search</button>
          </form>
          <button id="px-signout" title="Sign out of Plex" hidden>Sign out</button>
          <button id="px-close" title="Close">×</button>
        </div>
        <div class="px-body">
          <aside class="px-sidebar" id="px-sidebar">
            <div class="px-server"><select id="px-server" title="Plex Media Server"></select></div>
            <button class="px-nav-button" id="px-home">⌂ <span>Home</span></button>
            <button class="px-nav-button" id="px-livetv">📺 <span>Live TV</span></button>
            <div class="px-section-title">Libraries <button id="px-libraries-toggle">▾</button></div>
            <div id="px-libraries"></div>
          </aside>
          <main class="px-main" id="px-main"></main>
        </div>
      </div>`
    doc.body.appendChild(overlay)
    state.overlay = overlay
    state.uiDoc = doc

    ui('close').addEventListener('click', closeModal)
    ui('menu').addEventListener('click', () => {
      state.sidebarCollapsed = !state.sidebarCollapsed
      ui('sidebar').classList.toggle('collapsed', state.sidebarCollapsed)
    })
    ui('back').addEventListener('click', goBack)
    ui('home').addEventListener('click', () => navigate({ type: 'home', title: 'Home' }))
    ui('livetv').addEventListener('click', () => navigate({ type: 'livetv', title: 'Live TV' }))
    ui('libraries-toggle').addEventListener('click', () => {
      state.librariesCollapsed = !state.librariesCollapsed
      ui('libraries').hidden = state.librariesCollapsed
      ui('libraries-toggle').textContent = state.librariesCollapsed ? '▸' : '▾'
    })
    ui('server').addEventListener('change', (event) => void selectServer(event.target.value))
    ui('view-mode').addEventListener('change', (event) => {
      state.viewMode = event.target.value
      if (state.route) void renderRoute(state.route)
    })
    const qualitySelect = ui('quality')
    qualitySelect.value = state.videoQuality
    qualitySelect.addEventListener('change', (event) => {
      state.videoQuality = event.target.value
      localStorage.setItem(STORAGE.videoQuality, event.target.value)
    })
    ui('signout').addEventListener('click', signOut)
    ui('search-form').addEventListener('submit', (event) => {
      event.preventDefault()
      const query = ui('search').value.trim()
      if (query) void navigate({ type: 'search', title: `Search: ${query}`, query })
    })
    overlay.addEventListener('pointerdown', (event) => {
      if (!state.contextMenu?.contains(event.target)) removeContextMenu()
    })

    ui('sidebar').classList.toggle('collapsed', state.sidebarCollapsed)
    if (!ampwin.network?.request) {
      ui('sidebar').style.visibility = 'hidden'
      ui('signout').hidden = true
      setTitle('Ampwin update required')
      setMain(`
        <div class="px-login">
          <div class="px-login-card">
            <div class="px-login-logo">PLEXIFY</div>
            <h2>Network bridge unavailable</h2>
            <p>This running Ampwin build does not expose <code>ampwin.network.request</code>. Rebuild and restart Ampwin after adding the generic HTTP bridge, then disable and re-enable Plexify.</p>
          </div>
        </div>`)
      return
    }
    if (localStorage.getItem(STORAGE.userToken)) void initializeSession(false)
    else renderLogin()
  }

  function ui(id) {
    return state.overlay?.querySelector(`#px-${id}`) || null
  }

  function setTitle(title) {
    const el = ui('title')
    if (el) el.textContent = title
    const back = ui('back')
    if (back) back.disabled = state.history.length === 0
  }

  function setMain(node) {
    const main = ui('main')
    if (!main) return
    main.textContent = ''
    if (typeof node === 'string') main.innerHTML = node
    else if (node) main.appendChild(node)
  }

  function showMessage(message) {
    setMain(`<div class="px-message"><div><div class="px-brand">PLEXIFY</div><p>${escapeHtml(message)}</p></div></div>`)
  }

  function renderLogin() {
    if (!state.overlay) return
    ui('signout').hidden = true
    ui('sidebar').style.visibility = 'hidden'
    setTitle('Sign in')
    setMain(`
      <div class="px-login">
        <div class="px-login-card">
          <div class="px-login-logo">PLEXIFY</div>
          <h2>Connect your Plex account</h2>
          <p>Plexify will open Plex's official authorization page. Sign in there, approve this device, and return to Ampwin.</p>
          <button class="px-primary" id="px-login-button">Sign in with Plex</button>
          <p id="px-login-status" class="px-muted"></p>
        </div>
      </div>`)
    ui('login-button')?.addEventListener('click', () => void signIn())
  }

  async function initializeSession(force) {
    if (state.initializing && !force) return
    state.initializing = true
    try {
      ui('sidebar').style.visibility = 'visible'
      ui('signout').hidden = false
      showMessage('Discovering Plex Media Servers…')
      const token = localStorage.getItem(STORAGE.userToken)
      if (!token) return renderLogin()
      const resources = await requestJson({
        url: 'https://clients.plex.tv/api/v2/resources?includeHttps=1&includeRelay=1&includeIPv6=0',
        headers: plexHeaders(token)
      })
      state.servers = (Array.isArray(resources) ? resources : [])
        .filter((resource) => resource?.accessToken && resource?.connections?.length &&
          (`${resource.provides || ''}`.includes('server') || resource.product === 'Plex Media Server'))
        .map(normalizeServer)
        .filter((server) => server.uri)
      if (!state.servers.length) throw new Error('No reachable Plex Media Server was found')

      const wanted = localStorage.getItem(STORAGE.serverId)
      const selected = state.servers.find((server) => server.id === wanted) || state.servers[0]
      await selectServer(selected.id, true)
    } catch (error) {
      showMessage(error?.message || String(error))
    } finally {
      state.initializing = false
    }
  }

  function normalizeServer(resource) {
    const connections = [...resource.connections].filter((c) => /^https?:/i.test(c.uri || ''))
    connections.sort((a, b) => connectionScore(b) - connectionScore(a))
    return {
      id: resource.clientIdentifier || resource.name,
      name: resource.name || 'Plex Media Server',
      token: resource.accessToken,
      uri: connections[0]?.uri?.replace(/\/$/, '') || '',
      connections
    }
  }

  function connectionScore(connection) {
    return (connection.uri?.startsWith('https:') ? 100 : 0) + (connection.local ? 35 : 0) + (!connection.relay ? 15 : 0)
  }

  async function selectServer(id, initial = false) {
    const server = state.servers.find((candidate) => candidate.id === id)
    if (!server) return
    state.server = server
    localStorage.setItem(STORAGE.serverId, server.id)
    state.history = []
    state.route = null
    showMessage(`Connecting to ${server.name}…`)
    try {
      state.libraries = await loadLibraries()
      renderSidebar()
      await navigate({ type: 'home', title: 'Home' }, !initial)
    } catch (error) {
      showMessage(`Could not connect to ${server.name}: ${error?.message || error}`)
    }
  }

  async function serverJson(path, query = {}) {
    if (!state.server) throw new Error('No Plex server selected')
    const url = new URL(path, `${state.server.uri}/`)
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    return requestJson({ url: url.toString(), headers: plexHeaders(state.server.token) })
  }

  async function plexCloudJson(path, query = {}) {
    const token = localStorage.getItem(STORAGE.userToken)
    if (!token) throw new Error('No Plex account token is available')

    const url = new URL(path, 'https://epg.provider.plex.tv/')
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }

    return requestJson({
      url: url.toString(),
      headers: plexHeaders(token, {
        'X-Plex-Product': 'Plex Web',
        'X-Plex-Version': '4.145.1',
        'X-Plex-Platform': 'Chrome',
        'X-Plex-Device': 'Windows',
        'X-Plex-Model': 'hosted',
        'X-Plex-Provider-Version': '7.2',
        'X-Plex-Features': 'external-media,indirect-media',
        'X-Plex-Language': 'en',
        'X-Plex-Text-Format': 'plain'
      })
    })
  }

  async function loadLibraries() {
    const data = await serverJson('/library/sections')
    return data?.MediaContainer?.Directory || []
  }

  function renderSidebar() {
    const serverSelect = ui('server')
    serverSelect.textContent = ''
    for (const server of state.servers) {
      const option = state.uiDoc.createElement('option')
      option.value = server.id
      option.textContent = server.name
      option.selected = server.id === state.server?.id
      serverSelect.appendChild(option)
    }

    const list = ui('libraries')
    list.textContent = ''
    list.hidden = state.librariesCollapsed
    for (const library of state.libraries) {
      const button = state.uiDoc.createElement('button')
      button.className = 'px-library'
      button.textContent = `${libraryIcon(library.type)} ${library.title}`
      button.addEventListener('click', () => void navigate({
        type: 'library',
        title: library.title,
        key: library.key,
        libraryType: library.type
      }))
      list.appendChild(button)
    }
  }

  function libraryIcon(type) {
    return ({ movie: '▣', show: '▤', artist: '♪', photo: '▧' })[type] || '•'
  }

  async function navigate(route, push = true) {
    if (push && state.route) state.history.push(state.route)
    state.route = route
    setTitle(route.title)
    await renderRoute(route)
  }

  function goBack() {
    const route = state.history.pop()
    if (route) void navigate(route, false)
  }

  async function renderRoute(route) {
    const nonce = ++state.routeNonce
    if (route.type !== 'livetv') clearGuideNowTimer()
    showMessage(`Loading ${route.title}…`)
    try {
      let data
      if (route.type === 'home') {
        const hubs = await loadHomeHubs()
        if (nonce !== state.routeNonce) return
        renderHubs(hubs)
      } else if (route.type === 'library') {
        data = await serverJson(`/library/sections/${encodeURIComponent(route.key)}/all`, {
          sort: 'titleSort:asc',
          'X-Plex-Container-Start': 0,
          'X-Plex-Container-Size': 300
        })
        if (nonce !== state.routeNonce) return
        renderGrid(itemsFrom(data), route.title)
      } else if (route.type === 'children') {
        data = await serverJson(`/library/metadata/${encodeURIComponent(route.ratingKey)}/children`)
        if (nonce !== state.routeNonce) return

        const items = itemsFrom(data)
        const inferredParentType = items.some((item) => item.type === 'season')
          ? 'show'
          : items.some((item) => item.type === 'episode')
            ? 'season'
            : ''

        route.parentType = route.parentType || inferredParentType

        renderGrid(items, route.title, {
          parentType: route.parentType,
          ratingKey: route.ratingKey,
          title: route.title,
          visibleItems: items
        })
      } else if (route.type === 'search') {
        data = await serverJson('/hubs/search', { query: route.query, limit: 100 })
        if (nonce !== state.routeNonce) return
        const hubs = data?.MediaContainer?.Hub || []
        renderHubs(hubs, `No results for "${route.query}"`)
      } else if (route.type === 'livetv') {
        await renderLiveTV(nonce)
      }
    } catch (error) {
      if (nonce === state.routeNonce) showMessage(error?.message || String(error))
    }
  }

  async function loadHomeHubs() {
    // Try /hubs first (widely supported), then /hubs/home, then fall back to
    // recently-added items per library section.
    const endpoints = [
      { path: '/hubs', query: { includeMetadata: 1 } },
      { path: '/hubs/home', query: { includeMetadata: 1, includeLibraryPlaylists: 1 } }
    ]
    for (const ep of endpoints) {
      try {
        const data = await serverJson(ep.path, ep.query)
        const hubs = data?.MediaContainer?.Hub || []
        if (hubs.length) return hubs
      } catch {
        // endpoint not available on this server, try next
      }
    }
    // Final fallback: build pseudo-hubs from each library's recently added items
    const hubs = []
    for (const lib of state.libraries) {
      try {
        const data = await serverJson(
          `/library/sections/${encodeURIComponent(lib.key)}/recentlyAdded`,
          { 'X-Plex-Container-Start': 0, 'X-Plex-Container-Size': 20 }
        )
        const items = data?.MediaContainer?.Metadata || []
        if (items.length) {
          hubs.push({ title: `Recently Added in ${lib.title}`, Metadata: items })
        }
      } catch {
        // skip libraries that fail
      }
    }
    return hubs
  }

  function itemsFrom(data) {
    const container = data?.MediaContainer || {}
    return container.Metadata || container.Directory || []
  }

  function renderHubs(hubs, emptyMessage = 'No Plex home items were returned') {
    if (state.viewMode === 'list') {
      renderHubsList(hubs, emptyMessage)
      return
    }
    const root = state.uiDoc.createElement('div')
    let count = 0
    for (const hub of hubs) {
      const items = hub.Metadata || hub.Directory || []
      if (!items.length) continue
      count += items.length
      const section = state.uiDoc.createElement('section')
      section.className = 'px-hub'
      const heading = state.uiDoc.createElement('h2')
      heading.textContent = hub.title || 'Plex'
      const row = state.uiDoc.createElement('div')
      row.className = 'px-row'
      for (const item of items) row.appendChild(createCard(item))
      section.append(heading, row)
      root.appendChild(section)
    }
    if (!count) root.innerHTML = `<div class="px-empty">${escapeHtml(emptyMessage)}</div>`
    setMain(root)
  }

  function renderHubsList(hubs, emptyMessage) {
    const root = state.uiDoc.createElement('div')
    root.className = 'px-list'
    let count = 0
    let globalIndex = 0
    for (const hub of hubs) {
      const items = hub.Metadata || hub.Directory || []
      if (!items.length) continue
      count += items.length
      const header = state.uiDoc.createElement('div')
      header.className = 'px-list-section'
      header.textContent = hub.title || 'Plex'
      root.appendChild(header)
      for (const item of items) {
        root.appendChild(createListRow(item, ++globalIndex))
      }
    }
    if (!count) root.innerHTML = `<div class="px-empty">${escapeHtml(emptyMessage)}</div>`
    setMain(root)
  }

  function renderGrid(items, title, bulkContext = null) {
    if (state.viewMode === 'list') {
      renderGridList(items, title, bulkContext)
      return
    }

    const page = state.uiDoc.createElement('div')
    const actions = createBulkPlaylistActions(bulkContext)
    if (actions) page.appendChild(actions)

    if (!items.length) {
      const empty = state.uiDoc.createElement('div')
      empty.className = 'px-empty'
      empty.textContent = `Nothing was found in ${title}`
      page.appendChild(empty)
    } else {
      const grid = state.uiDoc.createElement('div')
      grid.className = 'px-grid'
      for (const item of items) grid.appendChild(createCard(item))
      page.appendChild(grid)
    }

    setMain(page)
  }

  function renderGridList(items, title, bulkContext = null) {
    const page = state.uiDoc.createElement('div')
    const actions = createBulkPlaylistActions(bulkContext)
    if (actions) page.appendChild(actions)

    const list = state.uiDoc.createElement('div')
    list.className = 'px-list'

    if (!items.length) {
      const empty = state.uiDoc.createElement('div')
      empty.className = 'px-empty'
      empty.textContent = `Nothing was found in ${title}`
      list.appendChild(empty)
    } else {
      for (let i = 0; i < items.length; i++) {
        list.appendChild(createListRow(items[i], i + 1))
      }
    }

    page.appendChild(list)
    setMain(page)
  }

  function createBulkPlaylistActions(context) {
    if (!context || !['show', 'season'].includes(context.parentType)) return null

    const bar = state.uiDoc.createElement('div')
    bar.className = 'px-bulk-actions'

    const button = state.uiDoc.createElement('button')
    const label = context.parentType === 'show' ? 'Add Series' : 'Add Season'
    button.textContent = `＋ ${label} to Playlist`
    button.title = `Add every episode in this ${context.parentType === 'show' ? 'series' : 'season'} to the current Ampwin playlist`

    button.addEventListener('click', () => {
      void addContainerEpisodesToPlaylist(context, button, label)
    })

    bar.appendChild(button)
    return bar
  }

  async function loadAllPlexItems(path) {
    const pageSize = 500
    const allItems = []
    let start = 0

    while (true) {
      const data = await serverJson(path, {
        includeMetadata: 1,
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': pageSize
      })

      const container = data?.MediaContainer || {}
      const pageItems = container.Metadata || container.Directory || []
      allItems.push(...pageItems)

      const totalSize = Number(container.totalSize || container.size || 0)
      if (!pageItems.length) break
      if (totalSize > 0 && allItems.length >= totalSize) break
      if (pageItems.length < pageSize) break

      start += pageItems.length
    }

    return allItems
  }

  function sortEpisodesForPlaylist(items) {
    return [...items].sort((a, b) => {
      const seasonA = Number(a.parentIndex ?? 0)
      const seasonB = Number(b.parentIndex ?? 0)
      if (seasonA !== seasonB) return seasonA - seasonB

      const episodeA = Number(a.index ?? 0)
      const episodeB = Number(b.index ?? 0)
      if (episodeA !== episodeB) return episodeA - episodeB

      return String(a.title || '').localeCompare(String(b.title || ''))
    })
  }

  async function addContainerEpisodesToPlaylist(context, button, label) {
    if (button.disabled) return

    const originalText = button.textContent
    button.disabled = true

    try {
      let episodes

      if (context.parentType === 'season') {
        episodes = context.visibleItems || []
      } else {
        episodes = await loadAllPlexItems(
          `/library/metadata/${encodeURIComponent(context.ratingKey)}/allLeaves`
        )
      }

      episodes = sortEpisodesForPlaylist(
        episodes.filter((item) => item.type === 'episode' || isPlayable(item))
      )

      if (!episodes.length) {
        toast(`No playable episodes were found in ${context.title}`)
        return
      }

      let added = 0
      let failed = 0

      for (let i = 0; i < episodes.length; i++) {
        button.textContent = `Adding ${i + 1} of ${episodes.length}…`

        try {
          const data = await remoteTrackData(episodes[i])
          ampwin.links.addSearchResult(data.result, data.audioOnly)
          added++
        } catch (error) {
          failed++
          console.warn('[Plexify] Could not add episode to playlist:', episodes[i], error)
        }
      }

      const episodeWord = added === 1 ? 'episode' : 'episodes'
      const failureText = failed ? `, ${failed} failed` : ''
      toast(`${label} complete: added ${added} ${episodeWord}${failureText}`)
    } catch (error) {
      console.error(`[Plexify] ${label} failed:`, error)
      toast(`Could not add ${context.title}: ${error?.message || error}`)
    } finally {
      button.disabled = false
      button.textContent = originalText
    }
  }

  function createListRow(item, index) {
    const row = state.uiDoc.createElement('div')
    row.className = 'px-list-row'
    row.title = cardTooltip(item)
    if (isPlayable(item)) row.classList.add('px-list-playable')
    else if (isContainer(item)) row.classList.add('px-list-container')

    const num = state.uiDoc.createElement('span')
    num.className = 'px-list-num'
    num.textContent = String(index)

    const name = state.uiDoc.createElement('span')
    name.className = 'px-list-name'
    const titleText = item.title || item.grandparentTitle || '(untitled)'
    const sub = cardSubtitle(item)
    name.textContent = sub ? `${titleText}  —  ${sub}` : titleText

    const type = state.uiDoc.createElement('span')
    type.className = 'px-list-type'
    type.textContent = item.type || ''

    const dur = state.uiDoc.createElement('span')
    dur.className = 'px-list-dur'
    dur.textContent = formatDuration(item.duration)

    row.append(num, name, type, dur)

    if (isContainer(item)) {
      row.addEventListener('click', () => void navigate({
        type: 'children',
        title: item.title || item.grandparentTitle || 'Plex',
        ratingKey: item.ratingKey,
        parentType: item.type
      }))
    }
    if (isPlayable(item)) {
      row.addEventListener('dblclick', () => void addToCurrent(item, true))
      row.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        void showContextMenu(item, event.clientX, event.clientY)
      })
    }
    return row
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return ''
    const totalSec = Math.round(ms / 1000)
    const m = Math.floor(totalSec / 60)
    const s = String(totalSec % 60).padStart(2, '0')
    return `${m}:${s}`
  }

  function createCard(item) {
    const card = state.uiDoc.createElement('article')
    card.className = 'px-card'
    card.dataset.type = item.type || ''
    card.title = cardTooltip(item)

    const poster = state.uiDoc.createElement('div')
    poster.className = 'px-poster'
    const art = item.type === 'episode'
      ? (item.grandparentThumb || item.parentThumb || item.thumb)
      : (item.thumb || item.parentThumb || item.grandparentThumb)
    if (art) {
      const image = state.uiDoc.createElement('img')
      image.loading = 'lazy'
      image.alt = ''
      image.src = authenticatedUrl(art)
      poster.appendChild(image)
    }
    if (item.viewOffset > 0 && item.duration > 0) {
      const progress = state.uiDoc.createElement('div')
      progress.className = 'px-progress'
      const fill = state.uiDoc.createElement('span')
      fill.style.width = `${Math.min(100, (item.viewOffset / item.duration) * 100)}%`
      progress.appendChild(fill)
      poster.appendChild(progress)
    }

    const title = state.uiDoc.createElement('div')
    title.className = 'px-card-title'
    title.textContent = item.title || item.grandparentTitle || '(untitled)'
    const subtitle = state.uiDoc.createElement('div')
    subtitle.className = 'px-card-subtitle'
    subtitle.textContent = cardSubtitle(item)
    card.append(poster, title, subtitle)

    if (isContainer(item)) {
      card.addEventListener('click', () => void navigate({
        type: 'children',
        title: item.title || item.grandparentTitle || 'Plex',
        ratingKey: item.ratingKey,
        parentType: item.type
      }))
    }
    if (isPlayable(item)) {
      card.addEventListener('dblclick', () => void addToCurrent(item, true))
      card.addEventListener('contextmenu', (event) => {
        event.preventDefault()
        void showContextMenu(item, event.clientX, event.clientY)
      })
    }
    return card
  }

  function isContainer(item) {
    return ['show', 'season', 'artist', 'album'].includes(item.type) && item.ratingKey
  }

  function isPlayable(item) {
    return ['movie', 'episode', 'track', 'clip'].includes(item.type)
  }

  function cardSubtitle(item) {
    if (item.type === 'episode') {
      const episode = item.index ? `E${String(item.index).padStart(2, '0')}` : ''
      const season = item.parentIndex ? `S${String(item.parentIndex).padStart(2, '0')}` : ''
      return `${item.grandparentTitle || ''} ${season}${episode}`.trim()
    }
    if (item.type === 'season') return `${item.leafCount ?? ''} episodes`.trim()
    if (item.type === 'album') return item.parentTitle || item.year || ''
    if (item.type === 'track') return item.grandparentTitle || item.parentTitle || ''
    return item.year || item.contentRating || item.type || ''
  }

  function cardTooltip(item) {
    const action = isPlayable(item) ? 'Double-click to play. Right-click for playlist options.' : 'Open'
    return `${item.title || 'Plex item'} — ${action}`
  }

  function authenticatedUrl(path) {
    if (!path || !state.server) return ''
    const url = new URL(path, `${state.server.uri}/`)
    url.searchParams.set('X-Plex-Token', state.server.token)
    return url.toString()
  }

  async function resolvePlayableItem(item) {
    const part = item.Media?.[0]?.Part?.[0]
    if (part?.key) return item
    if (!item.ratingKey) throw new Error('This Plex item has no playable media key')
    const data = await serverJson(`/library/metadata/${encodeURIComponent(item.ratingKey)}`, {
      includeGuids: 1,
      includeMarkers: 1
    })
    const full = data?.MediaContainer?.Metadata?.[0]
    if (!full?.Media?.[0]?.Part?.[0]?.key) throw new Error('Plex returned no playable media part')
    return full
  }

  function trackTitle(item) {
    if (item.type === 'episode') {
      const s = item.parentIndex ? `S${String(item.parentIndex).padStart(2, '0')}` : ''
      const e = item.index ? `E${String(item.index).padStart(2, '0')}` : ''
      return `${item.grandparentTitle ? `${item.grandparentTitle} — ` : ''}${s}${e} ${item.title || ''}`.trim()
    }
    return item.title || '(untitled)'
  }

  // ─── Live TV ────────────────────────────────────────────────────────

  async function discoverTVProviders() {
    if (!state.server) return []
    const providers = []

    // Local DVR source. Plex Web labels this with the server name, not the
    // DVR database key, which is why "DVR 68" was appearing here before.
    try {
      const dvrData = await serverJson('/livetv/dvrs')
      const dvrs = dvrData?.MediaContainer?.Dvr || []
      for (const dvr of dvrs) {
        const detail = dvr.lineupTitle || dvr.friendlyName || dvr.title || ''
        const title = dvrs.length > 1 && detail
          ? `${state.server.name} · ${detail}`
          : state.server.name

        providers.push({
          id: `dvr:${dvr.key}`,
          title,
          epgIdentifier: dvr.epgIdentifier || '',
          dvrKey: String(dvr.key),
          type: 'dvr'
        })
      }
    } catch (error) {
      console.warn('[Plexify] Failed to discover local DVRs:', error)
    }

    // Plex's free streaming channels are a cloud provider, not another DVR
    // attached to the selected Plex Media Server.
    try {
      const cloud = await plexCloudJson('/')
      if (cloud?.MediaProvider?.identifier === 'tv.plex.provider.epg') {
        providers.push({
          id: 'plex-cloud',
          title: 'Plex Channels',
          epgIdentifier: 'tv.plex.provider.epg',
          dvrKey: '',
          type: 'plex-cloud'
        })
      }
    } catch (error) {
      console.warn('[Plexify] Failed to discover Plex Channels:', error)
    }

    return providers
  }

  function cloudStreamKey(channel) {
    for (const media of channel?.Media || []) {
      for (const part of media?.Part || []) {
        if (part?.key) return part.key
      }
    }
    return ''
  }

  function cloudChannelHasDrm(channel) {
    return (channel?.Media || []).some((media) => Boolean(media?.drm))
  }

  function guideKeyForChannel(provider, channel) {
    if (provider?.type === 'plex-cloud') return channel.gridKey || ''
    return channel.gridKey || channel.channelIdentifier || channel.key || channel.guid || channel.id || ''
  }

  function liveTVThumbUrl(channel) {
    if (!channel?.thumb) return ''
    if (state.tvProvider?.type === 'plex-cloud') return channel.thumb
    return authenticatedUrl(channel.thumb)
  }

  async function fetchTVChannels(provider) {
    if (!provider) return []

    if (provider.type === 'plex-cloud') {
      const data = await plexCloudJson('/lineups/plex/channels')
      const channels = data?.MediaContainer?.Channel || []
      return channels.map((channel) => ({
        ...channel,
        channelIdentifier: channel.id || channel.slug || channel.gridKey || '',
        channelNumber: channel.vcn || channel.channelNumber || '',
        _streamKey: cloudStreamKey(channel),
        _drm: cloudChannelHasDrm(channel)
      }))
    }

    if (!state.server || !provider.epgIdentifier) return []

    const data = await serverJson(`/${provider.epgIdentifier}/lineups/dvr/channels`)
    const container = data?.MediaContainer || {}

    // Local DVR lineups are returned as MediaContainer.Channel. Older or
    // unusual Plex builds may use Metadata or Directory, so keep fallbacks.
    const channels = container.Channel || container.Metadata || container.Directory || []

    return channels.map((channel) => ({
      ...channel,
      channelIdentifier:
        channel.channelIdentifier ||
        channel.identifier ||
        channel.key ||
        channel.id ||
        '',
      channelNumber:
        channel.channelNumber ||
        channel.guideNumber ||
        channel.vcn ||
        channel.number ||
        channel.index ||
        '',
      title:
        channel.title ||
        channel.guideName ||
        channel.callSign ||
        channel.name ||
        channel.channelIdentifier ||
        channel.key ||
        'Unknown channel',
      thumb: channel.thumb || channel.logo || ''
    }))
  }

  async function fetchTVGrid(provider, channelKeys, date) {
    if (!provider || !channelKeys.length) return {}
    const guideData = {}

    // Fetch grid data in batches of 8 channels concurrently.
    const batchSize = 8
    for (let i = 0; i < channelKeys.length; i += batchSize) {
      const batch = channelKeys.slice(i, i + batchSize)
      await Promise.all(batch.map(async (chKey) => {
        try {
          const data = provider.type === 'plex-cloud'
            ? await plexCloudJson('/grid', { channelGridKey: chKey, date })
            : await serverJson(`/${provider.epgIdentifier}/grid`, { channelGridKey: chKey, date })
          guideData[chKey] = data?.MediaContainer?.Metadata || []
        } catch (error) {
          console.warn(`[Plexify] Failed to load guide channel ${chKey}:`, error)
          guideData[chKey] = []
        }
      }))
    }
    return guideData
  }

  function fmtGuideTime(epochSec) {
    return new Date(epochSec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }

  function fmtGuideDate(dateStr) {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
  }

  async function renderLiveTV(nonce) {
    showMessage('Discovering Live TV providers…')
    const providers = await discoverTVProviders()
    if (nonce !== state.routeNonce) return
    state.tvProviders = providers

    if (!providers.length) {
      showMessage('No Live TV providers found on this server. Make sure a DVR/tuner is configured in Plex.')
      return
    }
    if (!state.tvProvider || !providers.find(p => p.id === state.tvProvider?.id)) {
      state.tvProvider = providers[0]
    }

    if (state.tvProvider.type === 'dvr' && !state.tvProvider.epgIdentifier) {
      showMessage('Could not determine the DVR EPG provider identifier. Check DVR setup in Plex.')
      return
    }

    showMessage('Loading channels…')
    let channels = []
    try {
      channels = await fetchTVChannels(state.tvProvider)
    } catch (e) {
      console.warn('[Plexify] Failed to load channels:', e)
    }
    
    if (nonce !== state.routeNonce) return
    state.tvChannels = channels

    let guideData = {}
    if (channels.length > 0) {
      showMessage(`Loading guide for ${channels.length} channels…`)
      const channelKeys = channels
        .map((ch) => guideKeyForChannel(state.tvProvider, ch))
        .filter(Boolean)
      try {
        guideData = await fetchTVGrid(state.tvProvider, channelKeys.slice(0, 50), state.tvDate)
      } catch (e) {
        console.warn('[Plexify] Failed to load guide data:', e)
      }
    }
    
    if (nonce !== state.routeNonce) return
    state.tvGuideData = guideData

    renderGuideGrid(channels.slice(0, 50), guideData)
  }

  function clearGuideNowTimer() {
    if (state.tvNowTimer) clearInterval(state.tvNowTimer)
    state.tvNowTimer = null
  }

function guideEpochSeconds(value) {
  const number = Number(value || 0)

  if (!Number.isFinite(number) || number <= 0) {
    return 0
  }

  // Accept either Unix seconds or Unix milliseconds.
  return number > 100_000_000_000
    ? number / 1000
    : number
}

  function programBeginsAt(program) {
    return program?.beginsAt ?? program?.Media?.[0]?.beginsAt ?? 0
  }

  function programEndsAt(program) {
    return program?.endsAt ?? program?.Media?.[0]?.endsAt ?? 0
  }

  function channelDisplayParts(channel) {
    const number = String(
      channel?.channelNumber ||
      channel?.guideNumber ||
      channel?.vcn ||
      channel?.number ||
      channel?.index ||
      ''
    ).trim()

    let title = String(
      channel?.title ||
      channel?.guideName ||
      channel?.callSign ||
      channel?.name ||
      'Unknown'
    ).trim()

    if (number && title.startsWith(number)) {
      const remainder = title.slice(number.length)
      if (/^[\s\-:·]+/.test(remainder)) {
        title = remainder.replace(/^[\s\-:·]+/, '').trim() || title
      }
    }

    return {
      number,
      title,
      label: number ? `${number} ${title}` : title
    }
  }

  function renderGuideGrid(channels, guideData) {
    clearGuideNowTimer()

    const doc = state.uiDoc
    const container = doc.createElement('div')
    container.className = 'px-guide'

    const controls = doc.createElement('div')
    controls.className = 'px-guide-controls'

    const provSelect = doc.createElement('select')
    provSelect.title = 'Live TV Provider'
    for (const prov of state.tvProviders) {
      const opt = doc.createElement('option')
      opt.value = prov.id
      opt.textContent = prov.title
      opt.selected = prov.id === state.tvProvider?.id
      provSelect.appendChild(opt)
    }
    provSelect.addEventListener('change', (event) => {
      state.tvProvider =
        state.tvProviders.find((provider) => provider.id === event.target.value) ||
        state.tvProviders[0]
      void navigate({ type: 'livetv', title: 'Live TV' }, false)
    })

    const prevBtn = doc.createElement('button')
    prevBtn.textContent = '◀'
    prevBtn.title = 'Previous day'
    prevBtn.addEventListener('click', () => {
      const date = new Date(state.tvDate + 'T12:00:00')
      date.setDate(date.getDate() - 1)
      state.tvDate = localDateKey(date)
      void navigate({ type: 'livetv', title: 'Live TV' }, false)
    })

    const dateLabel = doc.createElement('span')
    dateLabel.className = 'px-guide-date'
    dateLabel.textContent = fmtGuideDate(state.tvDate)

    const nextBtn = doc.createElement('button')
    nextBtn.textContent = '▶'
    nextBtn.title = 'Next day'
    nextBtn.addEventListener('click', () => {
      const date = new Date(state.tvDate + 'T12:00:00')
      date.setDate(date.getDate() + 1)
      state.tvDate = localDateKey(date)
      void navigate({ type: 'livetv', title: 'Live TV' }, false)
    })

    const todayBtn = doc.createElement('button')
    todayBtn.textContent = 'Today'
    todayBtn.addEventListener('click', () => {
      state.tvDate = localDateKey()
      void navigate({ type: 'livetv', title: 'Live TV' }, false)
    })

    const refreshBtn = doc.createElement('button')
    refreshBtn.textContent = '↻ Refresh'
    refreshBtn.addEventListener('click', () => {
      void navigate({ type: 'livetv', title: 'Live TV' }, false)
    })

    const isToday = state.tvDate === localDateKey()

    controls.append(
      provSelect,
      prevBtn,
      dateLabel,
      nextBtn,
      todayBtn,
      refreshBtn
    )
    container.appendChild(controls)

    const scrollArea = doc.createElement('div')
    scrollArea.className = 'px-guide-channels'

    const CHANNEL_WIDTH = 130
    const HOUR_PX = 200
    const HALF_HOUR = 1800
    const HALF_HOUR_PX = HOUR_PX / 2
    const initialNowSec = Date.now() / 1000

    let earliestProgramStart = Number.POSITIVE_INFINITY
    let latestProgramEnd = 0

    for (const channel of channels) {
      const channelKey = guideKeyForChannel(state.tvProvider, channel)
      const programs = guideData[channelKey] || []

      for (const program of programs) {
        const startSec = guideEpochSeconds(programBeginsAt(program))
        const endSec =
          guideEpochSeconds(programEndsAt(program)) ||
          (startSec + HALF_HOUR)

        if (startSec > 0) {
          earliestProgramStart = Math.min(
            earliestProgramStart,
            startSec
          )
        }

        if (endSec > 0) {
          latestProgramEnd = Math.max(
            latestProgramEnd,
            endSec
          )
        }
      }
    }

    if (!Number.isFinite(earliestProgramStart)) {
      earliestProgramStart = isToday
        ? initialNowSec
        : new Date(
          state.tvDate + 'T00:00:00'
        ).getTime() / 1000
    }

    // Today begins at the current half-hour. Other dates begin at the
    // first half-hour containing guide data.
    const timelineStartSec = isToday
      ? Math.floor(initialNowSec / HALF_HOUR) * HALF_HOUR
      : Math.floor(earliestProgramStart / HALF_HOUR) * HALF_HOUR

    const minimumTimelineEnd = timelineStartSec + 4 * 3600
    const timelineEndSec =
      Math.ceil(
        Math.max(latestProgramEnd, minimumTimelineEnd) /
        HALF_HOUR
      ) * HALF_HOUR

    const timelineWidth =
      ((timelineEndSec - timelineStartSec) / HALF_HOUR) *
      HALF_HOUR_PX

    const timeRow = doc.createElement('div')
    timeRow.className = 'px-guide-time-row'
    timeRow.style.width =
      `${CHANNEL_WIDTH + timelineWidth}px`

    const timeCorner = doc.createElement('div')
    timeCorner.className = 'px-guide-time-corner'

    const timeAxis = doc.createElement('div')
    timeAxis.className = 'px-guide-time-axis'
    timeAxis.style.width = `${timelineWidth}px`
    timeAxis.style.flex = `0 0 ${timelineWidth}px`

    for (
      let tick = timelineStartSec;
      tick < timelineEndSec;
      tick += HALF_HOUR
    ) {
      const slot = doc.createElement('div')
      slot.className = 'px-guide-time-slot'
      slot.style.flex = `0 0 ${HALF_HOUR_PX}px`
      slot.textContent = fmtGuideTime(tick)
      timeAxis.appendChild(slot)
    }

    const topNowLine = doc.createElement('div')
    topNowLine.className = 'px-guide-time-now'
    topNowLine.hidden = true
    timeAxis.appendChild(topNowLine)

    timeRow.append(timeCorner, timeAxis)
    scrollArea.appendChild(timeRow)

    if (!channels.length) {
      const empty = doc.createElement('div')
      empty.className = 'px-guide-loading'
      empty.textContent = 'No channels found for this provider.'
      scrollArea.appendChild(empty)
    }

    for (const channel of channels) {
      const channelKey = guideKeyForChannel(
        state.tvProvider,
        channel
      )

      const programs = [
        ...(guideData[channelKey] || [])
      ].sort((a, b) =>
        guideEpochSeconds(programBeginsAt(a)) -
        guideEpochSeconds(programBeginsAt(b))
      )

      const row = doc.createElement('div')
      row.className = 'px-guide-ch-row'
      row.style.width =
        `${CHANNEL_WIDTH + timelineWidth}px`

      const channelName = doc.createElement('div')
      channelName.className = 'px-guide-ch-name'

      if (channel.thumb) {
        const image = doc.createElement('img')
        image.src = liveTVThumbUrl(channel)
        image.alt = ''
        image.loading = 'lazy'
        channelName.appendChild(image)
      }

      const channelParts = channelDisplayParts(channel)
      const nameSpan = doc.createElement('span')
      nameSpan.textContent = channelParts.label
      channelName.appendChild(nameSpan)
      channelName.title = channelParts.label
      channelName.addEventListener('click', () => {
        void tuneLiveChannel(channel, null)
      })

      const programArea = doc.createElement('div')
      programArea.className = 'px-guide-programs'
      programArea.style.width = `${timelineWidth}px`
      programArea.style.flex = `0 0 ${timelineWidth}px`

      let cursorSec = timelineStartSec
      let visibleProgramCount = 0

      for (const program of programs) {
        const originalStartSec =
          guideEpochSeconds(programBeginsAt(program))

        const originalEndSec =
          guideEpochSeconds(programEndsAt(program)) ||
          (originalStartSec + HALF_HOUR)

        if (
          originalEndSec <= timelineStartSec ||
          originalStartSec >= timelineEndSec
        ) {
          continue
        }

        const visibleStartSec = Math.max(
          originalStartSec,
          timelineStartSec
        )

        const visibleEndSec = Math.min(
          originalEndSec,
          timelineEndSec
        )

        if (visibleStartSec > cursorSec) {
          const gapWidth =
            ((visibleStartSec - cursorSec) / 3600) *
            HOUR_PX

          if (gapWidth > 0) {
            const gap = doc.createElement('div')
            gap.className = 'px-guide-gap'
            gap.style.flex = `0 0 ${gapWidth}px`
            programArea.appendChild(gap)
          }
        }

        const width =
          ((visibleEndSec - visibleStartSec) / 3600) *
          HOUR_PX

        if (width <= 0) continue

        const programElement = doc.createElement('div')
        programElement.className = 'px-guide-prog'
        programElement.dataset.startSec =
          String(originalStartSec)
        programElement.dataset.endSec =
          String(originalEndSec)
        programElement.dataset.visibleStartSec =
          String(visibleStartSec)
        programElement.dataset.visibleEndSec =
          String(visibleEndSec)
        programElement.style.flex = `0 0 ${width}px`
        programElement.setAttribute('role', 'button')
        programElement.tabIndex = 0

        const showTitle =
          program.grandparentTitle ||
          program.parentTitle ||
          program.originalTitle ||
          program.title ||
          '(No Title)'

        const titleElement = doc.createElement('div')
        titleElement.className = 'px-guide-prog-title'
        titleElement.textContent = showTitle

        const timeElement = doc.createElement('div')
        timeElement.className = 'px-guide-prog-time'
        timeElement.textContent =
          `${fmtGuideTime(originalStartSec)} – ` +
          `${fmtGuideTime(originalEndSec)}`

        programElement.append(
          titleElement,
          timeElement
        )

        const episodeTitle =
          program.title &&
          program.title !== showTitle
            ? program.title
            : ''

        programElement.title = [
          showTitle,
          episodeTitle,
          program.summary
        ].filter(Boolean).join('\n')

        const activate = () => {
          void tuneLiveChannel(channel, program)
        }

        programElement.addEventListener(
          'click',
          activate
        )

        programElement.addEventListener(
          'keydown',
          (event) => {
            if (
              event.key !== 'Enter' &&
              event.key !== ' '
            ) {
              return
            }

            event.preventDefault()
            activate()
          }
        )

        programArea.appendChild(programElement)
        cursorSec = visibleEndSec
        visibleProgramCount++
      }

      if (cursorSec < timelineEndSec) {
        const tailWidth =
          ((timelineEndSec - cursorSec) / 3600) *
          HOUR_PX

        const gap = doc.createElement('div')
        gap.className = 'px-guide-gap'
        gap.style.flex = `0 0 ${tailWidth}px`

        if (!visibleProgramCount) {
          const emptyTitle = doc.createElement('div')
          emptyTitle.className = 'px-guide-prog-title'
          emptyTitle.style.color = '#666'
          emptyTitle.style.padding = '17px 8px'
          emptyTitle.textContent = 'No guide data'
          gap.appendChild(emptyTitle)
        }

        programArea.appendChild(gap)
      }

      row.append(channelName, programArea)
      scrollArea.appendChild(row)
    }

    let lastCurrentSignature = ''

    const updateNow = () => {
      if (!scrollArea.isConnected) return ''

      const nowSec = Date.now() / 1000
      const currentPrograms = []

      const topLeft =
        ((nowSec - timelineStartSec) / 3600) *
        HOUR_PX

      const showTopLine =
        isToday &&
        nowSec >= timelineStartSec &&
        nowSec <= timelineEndSec

      topNowLine.hidden = !showTopLine

      if (showTopLine) {
        topNowLine.style.left = `${topLeft}px`
      }

      for (const programElement of scrollArea.querySelectorAll(
        '.px-guide-prog[data-start-sec]'
      )) {
        const startSec = guideEpochSeconds(
          programElement.dataset.startSec
        )

        const endSec = guideEpochSeconds(
          programElement.dataset.endSec
        )

        const visibleStartSec = guideEpochSeconds(
          programElement.dataset.visibleStartSec
        )

        const visibleEndSec = guideEpochSeconds(
          programElement.dataset.visibleEndSec
        )

        const airing =
          isToday &&
          nowSec >= startSec &&
          nowSec < endSec

        programElement.classList.toggle(
          'px-airing',
          airing
        )

        if (airing) {
          currentPrograms.push(
            `${startSec}:${endSec}`
          )

          const visibleProgress = Math.max(
            0,
            Math.min(
              100,
              ((nowSec - visibleStartSec) /
                (visibleEndSec - visibleStartSec)) *
                100
            )
          )

          const lineStart = Math.max(
            0,
            visibleProgress - 0.8
          )

          const lineEnd = Math.min(
            100,
            visibleProgress + 0.8
          )

          programElement.style.backgroundImage =
            `linear-gradient(to right, ` +
            `rgba(229,160,13,.24) 0%, ` +
            `rgba(229,160,13,.24) ${lineStart}%, ` +
            `#ffffff ${lineStart}%, ` +
            `#ffffff ${lineEnd}%, ` +
            `transparent ${lineEnd}%, ` +
            `transparent 100%)`

          programElement.style.boxShadow =
            'inset 0 -3px 0 #e5a00d'
        } else {
          programElement.style.backgroundImage = ''
          programElement.style.boxShadow = ''
        }
      }

      return currentPrograms.sort().join('|')
    }

    container.appendChild(scrollArea)
    setMain(container)

    lastCurrentSignature = updateNow()

    // Today's ruler begins at the current half-hour, so no horizontal
    // offset is needed to find the current program.
    if (isToday) {
      scrollArea.scrollLeft = 0

      state.tvNowTimer = setInterval(() => {
        if (!scrollArea.isConnected) {
          clearGuideNowTimer()
          return
        }

        const currentSignature = updateNow()

        if (
          lastCurrentSignature &&
          currentSignature !== lastCurrentSignature
        ) {
          clearGuideNowTimer()
          void navigate(
            { type: 'livetv', title: 'Live TV' },
            false
          )
          return
        }

        lastCurrentSignature = currentSignature
      }, 15_000)
    }
  }

  function addAndPlayLiveResult(result) {
    const track = ampwin.links.addSearchResult(result, false)

    // Match the playback path already used by normal Plexify video items.
    const tracks = ampwin.playlist?.getTracks?.() || []
    const index = tracks.findIndex((candidate) => candidate.id === track?.id)

    if (index >= 0 && ampwin.playlist?.playIndex) {
      ampwin.playlist.playIndex(index)
    } else if (ampwin.links?.play) {
      // Compatibility fallback for older Ampwin builds.
      ampwin.links.play(track)
    }

    return track
  }

  function asArray(value) {
    if (value === undefined || value === null) return []
    return Array.isArray(value) ? value : [value]
  }

  function normalizeTuneIdentifier(value) {
    if (value === undefined || value === null) return []
    const raw = String(value).trim()
    if (!raw) return []

    const values = []

    const add = (candidate) => {
      if (candidate === undefined || candidate === null) return
      let normalized = String(candidate).trim()
      if (!normalized) return
      try { normalized = decodeURIComponent(normalized) } catch {}
      normalized = normalized.replace(/^channel:\/\//i, '')
      normalized = normalized.replace(/^\/+|\/+$/g, '')
      if (normalized && !values.includes(normalized)) values.push(normalized)
    }

    // A Plex key can be a full provider path. The tune endpoint needs only
    // the channel identifier portion.
    const channelMatch = raw.match(/\/channels\/([^/?#]+)/i)
    if (channelMatch) add(channelMatch[1])

    add(raw)

    if (raw.includes('/')) {
      const parts = raw.split('/').filter(Boolean)
      add(parts[parts.length - 1])
    }

    return values
  }

  function collectLiveTVTuneIdentifiers(channel, program) {
    const candidates = []
    const add = (value) => {
      for (const id of normalizeTuneIdentifier(value)) {
        if (!candidates.includes(id)) candidates.push(id)
      }
    }

    // Program metadata is first because Plex's grid response can expose the
    // exact composite identifier used by /channels/<id>/tune.
    for (const value of [
      program?.channelIdentifier,
      program?.channelId,
      program?.channelID,
      program?.channelKey,
      program?.channelGuid,
      program?.gridKey,
      channel?.tuneIdentifier,
      channel?.channelIdentifier,
      channel?.identifier,
      channel?.id,
      channel?.guid,
      channel?.key,
      channel?.gridKey,
      channel?.channelNumber,
      channel?.guideNumber,
      channel?.vcn,
      channel?.number,
      channel?.index
    ]) {
      add(value)
    }

    // Composite Plex/XMLTV identifiers are usually safer than display-only
    // channel numbers, so try them first while retaining numeric fallbacks.
    return candidates.sort((a, b) => {
      const aComposite = /[A-Za-z.:_-]/.test(a) ? 1 : 0
      const bComposite = /[A-Za-z.:_-]/.test(b) ? 1 : 0
      return bComposite - aComposite
    })
  }

  function collectLiveTVSessionPaths(value) {
    const paths = []
    const seen = new Set()

    const addPath = (candidate) => {
      if (candidate === undefined || candidate === null) return
      const raw = String(candidate).trim()
      if (!raw) return

      const direct = raw.match(/\/livetv\/sessions\/([^"'&<>\s]+)/i)
      if (direct) {
        const path = `/livetv/sessions/${direct[1]}`
        if (!paths.includes(path)) paths.push(path)
        return
      }

      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
        const path = `/livetv/sessions/${raw}`
        if (!paths.includes(path)) paths.push(path)
      }
    }

    const walk = (node, parentKey = '') => {
      if (node === undefined || node === null) return

      if (typeof node === 'string' || typeof node === 'number') {
        if (
          /^(key|ratingKey|session|sessionKey|uuid)$/i.test(parentKey) ||
          String(node).includes('/livetv/sessions/')
        ) {
          addPath(node)
        }
        return
      }

      if (typeof node !== 'object' || seen.has(node)) return
      seen.add(node)

      if (Array.isArray(node)) {
        for (const item of node) walk(item, parentKey)
        return
      }

      for (const [key, child] of Object.entries(node)) {
        walk(child, key)
      }
    }

    walk(value)
    return paths
  }

  function firstObject(value) {
    if (!value) return null
    if (Array.isArray(value)) {
      return value.find((item) => item && typeof item === 'object') || null
    }
    return typeof value === 'object' ? value : null
  }

  function extractLocalDvrTuneMetadata(tuneBody) {
    const container = tuneBody?.MediaContainer || tuneBody || {}
    const subscription = firstObject(container.MediaSubscription)
    const operation = firstObject(subscription?.MediaGrabOperation)

    const nestedMetadata = firstObject(operation?.Metadata)
    if (nestedMetadata) return nestedMetadata

    return firstObject(container.Metadata)
  }

  function extractLiveTVSessionPathFromText(rawBody) {
    if (!rawBody) return ''

    try {
      const parsed = JSON.parse(rawBody)
      const metadata = extractLocalDvrTuneMetadata(parsed)
      const metadataKey = String(metadata?.key || '')
      if (metadataKey.includes('/livetv/sessions/')) return metadataKey

      const jsonPath = collectLiveTVSessionPaths(parsed)[0]
      if (jsonPath) return jsonPath
    } catch {}

    // Prefer a Metadata key over any unrelated UUID elsewhere in the response.
    const metadataKey =
      rawBody.match(/<Metadata\b[^>]*\bkey=["']([^"']*\/livetv\/sessions\/[^"']+)["']/i) ||
      rawBody.match(/["']key["']\s*:\s*["']([^"']*\/livetv\/sessions\/[^"']+)["']/i)

    if (metadataKey?.[1]) return metadataKey[1]

    const direct = rawBody.match(/\/livetv\/sessions\/([^"'&<>\s]+)/i)
    if (direct) return `/livetv/sessions/${direct[1]}`

    return ''
  }

  function extractLocalDvrRatingKey(rawBody) {
    if (!rawBody) return ''

    try {
      const parsed = JSON.parse(rawBody)
      const metadata = extractLocalDvrTuneMetadata(parsed)
      return String(metadata?.ratingKey || metadata?.key || '')
    } catch {}

    const match =
      rawBody.match(/<Metadata\b[^>]*\bratingKey=["']([^"']+)["']/i) ||
      rawBody.match(/["']ratingKey["']\s*:\s*["']?([^"',}\s]+)["']?/i)

    return match?.[1] || ''
  }

  async function currentLiveTVSessionPaths() {
    try {
      const sessions = await serverJson('/livetv/sessions')
      return collectLiveTVSessionPaths(sessions)
    } catch {
      return []
    }
  }

  async function requestLocalDvrTune(dvrKey, tuneId, sessionsBefore) {
    const sessionIdentifier = crypto.randomUUID()
    const tuneUrl = new URL(
      `/livetv/dvrs/${encodeURIComponent(dvrKey)}` +
      `/channels/${encodeURIComponent(tuneId)}/tune`,
      `${state.server.uri}/`
    )

    // Plex's DVR tune and transcode-decision requests must share this ID.
    tuneUrl.searchParams.set(
      'X-Plex-Session-Identifier',
      sessionIdentifier
    )

    const tuneResp = await ampwin.network.request({
      url: tuneUrl.toString(),
      method: 'POST',
      timeoutMs: 60_000,
      headers: plexHeaders(state.server.token, {
        Accept: 'application/json, application/xml'
      })
    })

    if (!tuneResp?.ok) {
      const detail = typeof tuneResp?.body === 'string'
        ? tuneResp.body.slice(0, 240)
        : ''
      throw new Error(
        `HTTP ${tuneResp?.status || 'unknown'}` +
        (detail ? `: ${detail}` : '')
      )
    }

    const rawBody = typeof tuneResp.body === 'string'
      ? tuneResp.body
      : JSON.stringify(tuneResp.body || '')

    let sessionPath = extractLiveTVSessionPathFromText(rawBody)

    // Some PMS builds acknowledge tuning before exposing the session in the
    // response. Poll only as a fallback.
    if (!sessionPath) {
      for (let attempt = 0; attempt < 5 && !sessionPath; attempt++) {
        await sleep(250)
        const after = await currentLiveTVSessionPaths()
        sessionPath =
          after.find((path) => !sessionsBefore.has(path)) ||
          (after.length === 1 ? after[0] : '')
      }
    }

    return {
      sessionPath,
      ratingKey: extractLocalDvrRatingKey(rawBody),
      sessionIdentifier,
      rawBody,
      tuneUrl: tuneUrl.toString()
    }
  }


  async function sendLiveTVTimeline(live, playbackState = 'playing') {
    if (!live || !state.server) return

    try {
      const url = new URL('/:/timeline', `${state.server.uri}/`)
      if (live.ratingKey) {
        url.searchParams.set('ratingKey', live.ratingKey)
      }
      url.searchParams.set('key', live.sessionPath)
      url.searchParams.set('playbackTime', '0')
      url.searchParams.set('state', playbackState)
      url.searchParams.set('hasMDE', '1')
      url.searchParams.set('time', '0')
      url.searchParams.set('duration', '4294967296000')
      url.searchParams.set(
        'X-Plex-Session-Identifier',
        live.sessionIdentifier
      )
      url.searchParams.set('X-Plex-Client-Identifier', clientId)
      url.searchParams.set('X-Plex-Product', PRODUCT)
      url.searchParams.set('X-Plex-Token', state.server.token)

      await request({
        url: url.toString(),
        method: 'GET',
        timeoutMs: 10_000,
        headers: plexHeaders(state.server.token)
      })
    } catch (error) {
      console.warn('[Plexify] Live TV timeline update failed:', error)
    }
  }

  function stopLiveTVKeepalive(sendStopped = false) {
    const live = state.tvLiveSession
    state.tvLiveSession = null
    if (!live) return

    if (live.keepaliveTimer) clearInterval(live.keepaliveTimer)
    if (sendStopped) void sendLiveTVTimeline(live, 'stopped')
  }

  function startLiveTVKeepalive(info) {
    stopLiveTVKeepalive(true)

    const live = {
      ...info,
      keepaliveTimer: null
    }

    state.tvLiveSession = live
    void sendLiveTVTimeline(live, 'playing')

    live.keepaliveTimer = setInterval(() => {
      if (state.tvLiveSession !== live) return
      void sendLiveTVTimeline(live, 'playing')
    }, 15_000)
  }

  function encodePlexQuery(params) {
    return Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
      )
      .join('&')
  }

  async function buildLocalDvrStream(
    sessionPath,
    sessionIdentifier
  ) {
    if (!state.server) throw new Error('No Plex server selected')

    const transcodeSessionId = crypto.randomUUID()

    // This parameter set mirrors current Plex DVR clients. The tune request,
    // decision request, timeline updates, and final stream all reuse the same
    // X-Plex-Session-Identifier.
    const params = {
      hasMDE: 1,
      path: sessionPath,
      mediaIndex: 0,
      partIndex: 0,
      protocol: 'http',
      fastSeek: 1,
      directPlay: 0,
      directStream: 1,
      subtitleSize: 100,
      audioBoost: 100,
      location: 'lan',
      addDebugOverlay: 0,
      autoAdjustQuality: 0,
      directStreamAudio: 1,
      advancedSubtitles: 'text',
      mediaBufferSize: 157286,
      session: transcodeSessionId,
      subtitles: 'auto',
      copyts: 0,
      'Accept-Language': 'en',
      'X-Plex-Session-Identifier': sessionIdentifier,
      'X-Plex-Chunked': 1,
      'X-Plex-Incomplete-Segments': 1,
      'X-Plex-Product': PRODUCT,
      'X-Plex-Version': VERSION,
      'X-Plex-Client-Identifier': clientId,
      'X-Plex-Platform': 'Flutter',
      'X-Plex-Client-Profile-Name': 'Plex Desktop',
      'X-Plex-Token': state.server.token
    }

    const query = encodePlexQuery(params)
    const decisionUrl =
      `${state.server.uri}/video/:/transcode/universal/decision?${query}`

    // Plex expects the transcode decision before the start request. The old
    // start.mpd shortcut returned HTTP 400 because it skipped this step and
    // used the wrong protocol/profile combination.
    const decision = await request({
      url: decisionUrl,
      method: 'GET',
      timeoutMs: 30_000,
      headers: {
        Accept: 'application/json, application/xml, text/xml, */*',
        'Accept-Language': 'en'
      }
    })

    if (!decision.ok) {
      const detail = decision.body?.slice(0, 500) || ''
      console.error('[Plexify] Live TV transcode decision failed', {
        status: decision.status,
        body: detail,
        decisionUrl
      })
      throw new Error(
        `Plex Live TV decision returned HTTP ${decision.status}` +
        (detail ? `: ${detail}` : '')
      )
    }

    console.info('[Plexify] Live TV transcode decision accepted', {
      sessionPath,
      sessionIdentifier,
      transcodeSessionId,
      preview: decision.body?.slice(0, 500)
    })

    // Ampwin recognizes the .mp4 route as direct video and therefore preserves
    // the complete Plex query instead of handing the URL to yt-dlp. Plex's
    // universal HTTP transcoder uses the same accepted decision parameters.
    const streamUrl =
      `${state.server.uri}/video/:/transcode/universal/start.mp4?${query}`

    return {
      url: streamUrl,
      sessionIdentifier,
      transcodeSessionId
    }
  }


  async function tunePlexCloudChannel(channel) {
    const token = localStorage.getItem(STORAGE.userToken)
    const streamKey = channel?._streamKey || cloudStreamKey(channel)

    if (!token) {
      toast('No Plex account token is available')
      return
    }
    if (channel?._drm || cloudChannelHasDrm(channel)) {
      toast('This Plex channel uses DRM and cannot be played by Plexify yet')
      return
    }
    if (!streamKey) {
      toast('Plex returned no playable stream for this channel')
      return
    }

    const streamUrl = new URL(streamKey, 'https://epg.provider.plex.tv/')
    streamUrl.searchParams.set('X-Plex-Token', token)
    streamUrl.searchParams.set('X-Plex-Client-Identifier', clientId)

    const title = `📺 ${channel.title || channel.callSign || 'Plex Channel'}`
    const result = {
      url: streamUrl.toString(),
      title,
      durationSec: 0,
      uploader: 'Plex Channels',
      thumbnail: liveTVThumbUrl(channel)
    }
    addAndPlayLiveResult(result)
    toast(`Starting: ${channel.title || channel.callSign || 'Plex Channel'}`)
  }

  async function tuneLiveChannel(channel, program = null) {
    if (state.tvProvider?.type === 'plex-cloud') {
      await tunePlexCloudChannel(channel)
      return
    }

    if (!state.server) return

    const tuneIds = collectLiveTVTuneIdentifiers(channel, program)
    if (!tuneIds.length) {
      toast('No DVR channel identifier was returned by Plex')
      return
    }

    const dvrKey = state.tvProvider?.dvrKey || ''
    if (!dvrKey) {
      toast('No DVR key available')
      return
    }

    const currentProgramTitle =
      program?.grandparentTitle ||
      program?.parentTitle ||
      program?.title ||
      channel.title ||
      tuneIds[0]

    const channelParts = channelDisplayParts(channel)
    const playlistTitle = channelParts.label

    toast(`Tuning to ${currentProgramTitle}…`)

    try {
      const sessionsBefore = new Set(await currentLiveTVSessionPaths())
      let successfulTune = null
      let successfulTuneId = ''
      const diagnostics = []

      // The lineup/grid APIs do not always expose the same field as the tune
      // endpoint expects. Try every plausible raw Plex identifier, not merely
      // the display channel number.
      for (const tuneId of tuneIds) {
        try {
          const result = await requestLocalDvrTune(
            dvrKey,
            tuneId,
            sessionsBefore
          )

          diagnostics.push({
            tuneId,
            tuneUrl: result.tuneUrl,
            response: result.rawBody.slice(0, 1000)
          })

          if (result.sessionPath) {
            successfulTune = result
            successfulTuneId = tuneId
            break
          }
        } catch (error) {
          diagnostics.push({
            tuneId,
            error: error?.message || String(error)
          })
        }
      }

      if (!successfulTune) {
        console.warn(
          '[Plexify] DVR tune produced no Live TV session',
          {
            channel,
            program,
            attemptedTuneIds: tuneIds,
            diagnostics
          }
        )
        toast(
          `Plex returned no DVR session. Tried channel IDs: ` +
          tuneIds.slice(0, 4).join(', ')
        )
        return
      }

      const sessionPath = successfulTune.sessionPath

      console.info(
        '[Plexify] DVR tune session opened',
        {
          successfulTuneId,
          sessionPath,
          sessionIdentifier: successfulTune.sessionIdentifier,
          ratingKey: successfulTune.ratingKey
        }
      )

      const livePlayback = await buildLocalDvrStream(
        sessionPath,
        successfulTune.sessionIdentifier
      )

      const result = {
        url: livePlayback.url,
        title: playlistTitle,
        durationSec: 0,
        uploader: state.server.name || 'Live TV',
        thumbnail: liveTVThumbUrl(channel)
      }

      addAndPlayLiveResult(result)
      startLiveTVKeepalive({
        url: livePlayback.url,
        sessionPath,
        ratingKey:
          successfulTune.ratingKey ||
          String(program?.ratingKey || ''),
        sessionIdentifier: livePlayback.sessionIdentifier,
        transcodeSessionId: livePlayback.transcodeSessionId
      })
      toast(`Starting: ${channelParts.label}`)
    } catch (error) {
      console.error('[Plexify] DVR tune failed:', error)
      toast(`Failed to tune: ${error?.message || error}`)
    }
  }

  const QUALITY_MAP = {
    '1080p': { resolution: '1920x1080', bitrate: 20000 },
    '720p':  { resolution: '1280x720',  bitrate: 4000 },
    '480p':  { resolution: '720x480',   bitrate: 2000 },
    '360p':  { resolution: '640x360',   bitrate: 750 }
  }

  function transcodedUrl(full) {
    if (!state.server) return ''

    const q = QUALITY_MAP[state.videoQuality] || QUALITY_MAP['720p']
    const playbackSession = crypto.randomUUID()

    // Retained only as a legacy helper. Normal library playback now uses the
    // authenticated original Part URL so Ampwin's generic seek path works.
    const url = new URL(
      '/video/:/transcode/universal/start.m3u8',
      `${state.server.uri}/`
    )

    url.searchParams.set('path', `/library/metadata/${full.ratingKey}`)
    url.searchParams.set('mediaIndex', '0')
    url.searchParams.set('partIndex', '0')
    url.searchParams.set('protocol', 'hls')
    url.searchParams.set('offset', '0')
    url.searchParams.set('fastSeek', '1')
    url.searchParams.set('directPlay', '0')
    url.searchParams.set('directStream', '1')
    url.searchParams.set('directStreamAudio', '0')
    url.searchParams.set('videoQuality', '100')
    url.searchParams.set('maxVideoBitrate', String(q.bitrate))
    url.searchParams.set('videoResolution', q.resolution)
    url.searchParams.set('audioBoost', '100')
    url.searchParams.set('location', 'lan')
    url.searchParams.set('subtitles', 'burn')
    url.searchParams.set('hasMDE', '1')
    url.searchParams.set('autoAdjustQuality', '0')
    url.searchParams.set('session', playbackSession)
    url.searchParams.set('X-Plex-Session-Identifier', playbackSession)
    url.searchParams.set('X-Plex-Chunked', '1')
    url.searchParams.set('X-Plex-Client-Profile-Name', 'Chrome')
    url.searchParams.set('X-Plex-Platform', 'Chrome')
    url.searchParams.set('X-Plex-Token', state.server.token)
    url.searchParams.set('X-Plex-Client-Identifier', clientId)
    url.searchParams.set('X-Plex-Product', PRODUCT)

    return url.toString()
  }

  async function remoteTrackData(item) {
    const full = await resolvePlayableItem(item)
    const part = full.Media[0].Part[0]
    const directPath = authenticatedUrl(part.key)
    const audioOnly = full.type === 'track'
    const title = trackTitle(full)
    const artist = full.grandparentTitle || full.parentTitle || full.originalTitle || full.studio || ''
    const durationSec = Math.round((full.duration || 0) / 1000)
    // Always give Ampwin the real Plex media Part URL for normal libraries.
    // A Plex universal-transcode response is a live/progressive request anchored
    // to offset=0, so ordinary HTML-video seeking restarts it. The original Part
    // URL is byte-seekable, and Ampwin's existing generic ffmpeg/MSE fallback
    // handles unsupported containers/codecs without any Plex-specific host code.
    const path = directPath
    return {
      full,
      path,
      audioOnly,
      result: {
        url: path,
        title,
        durationSec,
        uploader: artist,
        thumbnail: full.thumb ? authenticatedUrl(full.thumb) : ''
      }
    }
  }

  async function addToCurrent(item, play) {
    try {
      const data = await remoteTrackData(item)
      const track = ampwin.links.addSearchResult(data.result, data.audioOnly)
      if (play) {
        const index = ampwin.playlist.getTracks().findIndex((candidate) => candidate.id === track.id)
        if (index >= 0) ampwin.playlist.playIndex(index)
        toast(`Playing ${track.title}`)
      } else {
        toast(`Added ${track.title} to the Ampwin playlist`)
      }
      return track
    } catch (error) {
      toast(`Could not add item: ${error?.message || error}`)
      throw error
    }
  }

  async function makeSavedTrack(item) {
    const data = await remoteTrackData(item)
    return {
      id: crypto.randomUUID(),
      path: data.path,
      title: data.result.title,
      artist: data.result.uploader,
      album: data.full.parentTitle || data.full.grandparentTitle || '',
      durationSec: data.result.durationSec,
      codec: 'stream',
      verdict: 'native',
      isVideo: !data.audioOnly,
      mtimeMs: 0,
      isRemote: true,
      audioOnly: data.audioOnly
    }
  }

  async function showContextMenu(item, x, y) {
    removeContextMenu()
    const menu = state.uiDoc.createElement('div')
    menu.className = 'px-context'
    const view = state.uiDoc.defaultView
    menu.style.left = `${Math.max(4, Math.min(x, (view?.innerWidth || 680) - 290))}px`
    menu.style.top = `${Math.max(4, Math.min(y, (view?.innerHeight || 560) - 260))}px`
    state.overlay.appendChild(menu)
    state.contextMenu = menu

    addContextAction(menu, '▶ Play now', () => addToCurrent(item, true))
    addContextAction(menu, '＋ Add to current playlist', () => addToCurrent(item, false))
    const divider = state.uiDoc.createElement('hr')
    menu.appendChild(divider)
    const label = state.uiDoc.createElement('div')
    label.className = 'px-context-label'
    label.textContent = 'Add to saved playlist'
    menu.appendChild(label)

    try {
      const playlists = await ampwin.playlist.saved.list()
      if (!menu.isConnected) return
      if (!playlists.length) {
        const empty = state.uiDoc.createElement('div')
        empty.className = 'px-context-label'
        empty.textContent = 'No saved playlists'
        menu.appendChild(empty)
      }
      for (const playlist of playlists) {
        addContextAction(menu, playlist.name, async () => {
          const track = await makeSavedTrack(item)
          await ampwin.playlist.saved.addTracksTo(playlist.id, [track])
          toast(`Added ${track.title} to ${playlist.name}`)
        })
      }
    } catch (error) {
      const failed = state.uiDoc.createElement('div')
      failed.className = 'px-context-label'
      failed.textContent = error?.message || String(error)
      menu.appendChild(failed)
    }
  }

  function addContextAction(menu, label, action) {
    const button = state.uiDoc.createElement('button')
    button.textContent = label
    button.addEventListener('click', () => {
      removeContextMenu()
      void Promise.resolve(action()).catch((error) => toast(error?.message || String(error)))
    })
    menu.appendChild(button)
  }

  function removeContextMenu() {
    state.contextMenu?.remove()
    state.contextMenu = null
  }

  function toast(message) {
    const main = ui('main')
    if (!main) return
    main.querySelector('.px-toast')?.remove()
    const el = state.uiDoc.createElement('div')
    el.className = 'px-toast'
    el.textContent = message
    main.appendChild(el)
    setTimeout(() => el.remove(), 3200)
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function isPlexPlaybackTrack(track) {
    const path = String(track?.path || '')
    return (
      path.includes('/video/:/transcode/universal/') ||
      path.includes('/livetv/sessions/') ||
      path.includes('/library/parts/') ||
      path.includes('epg.provider.plex.tv')
    )
  }

  function installPlaybackDiagnostics() {
    if (!ampwin.player?.on) return

    if (!state.playerTrackUnsub) {
      state.playerTrackUnsub = ampwin.player.on('track', (track) => {
        const live = state.tvLiveSession
        if (!live) return

        const activePath = String(track?.path || '')
        if (activePath !== live.url) stopLiveTVKeepalive(true)
      })
    }

    if (state.playerErrorUnsub) return

    state.playerErrorUnsub = ampwin.player.on('error', (message, track) => {
      if (!isPlexPlaybackTrack(track)) return

      console.error('[Plexify] Ampwin rejected Plex playback:', {
        message,
        track
      })

      const path = String(track?.path || '')
      if (
        state.tvLiveSession &&
        path === state.tvLiveSession.url
      ) {
        stopLiveTVKeepalive(true)
      }
      const resolverMisclassified =
        /can't play this without signing in/i.test(String(message)) &&
        path.includes('/video/:/transcode/universal/')

      toast(
        resolverMisclassified
          ? 'Plex playback failed: Ampwin treated the Plex stream as a website link'
          : `Plex playback failed: ${message}`
      )
    })
  }

  function boot() {
    installIntoSkin()
    installPlaybackDiagnostics()
    if (!ampwin.network?.request) console.warn('Plexify: ampwin.network.request is unavailable')
    
    // Robustly ensure the button stays injected even after skin reloads
    state.watchdog = setInterval(() => {
      const doc = currentSkinDocument()
      if (doc?.body) {
        if (!doc.getElementById('plexify-launch')) {
          installLaunchButton(doc)
          if (doc.getElementById('plexify-launch')) removeHostFallback()
        }
      } else {
        if (!window.parent.document.getElementById('plexify-host-launch')) {
          installHostFallback()
        }
      }
    }, 1000)
  }

  window.addEventListener('unload', () => {
    clearGuideNowTimer()
    if (state.watchdog) clearInterval(state.watchdog)
    stopLiveTVKeepalive(true)
    try { state.playerErrorUnsub?.() } catch {}
    try { state.playerTrackUnsub?.() } catch {}
    state.playerErrorUnsub = null
    state.playerTrackUnsub = null
    try { state.authWindow?.close() } catch {}
    try { state.appWindow?.close() } catch {}
    removeHostFallback()
    try {
      const host = window.parent.document
      host.querySelectorAll('#skin-layer iframe').forEach((frame) => {
        const doc = frame.contentDocument
        doc?.getElementById('plexify-launch')?.remove()
        doc?.getElementById('plexify-modal')?.remove()
        doc?.getElementById('plexify-style')?.remove()
      })
    } catch {}
  })

  boot()
})()
