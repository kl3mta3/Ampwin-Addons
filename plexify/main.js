/* global ampwin */
;(() => {
  'use strict'

  const ADDON_ID = 'plexify'
  const PRODUCT = 'Plexify'
  const VERSION = '1.0.9'
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
    tvDate: new Date().toISOString().slice(0, 10),
    tvLiveSession: null
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
    #plexify-modal .px-guide-channels { overflow: auto; max-height: calc(100vh - 160px); border: 1px solid rgba(127,127,127,.15); border-radius: 5px; }
    #plexify-modal .px-guide-ch-row { display: flex; min-height: 48px; border-bottom: 1px solid rgba(127,127,127,.1); }
    #plexify-modal .px-guide-ch-name { width: 130px; flex: 0 0 130px; display: flex; align-items: center;
      gap: 6px; padding: 4px 8px; background: rgba(0,0,0,.25); border-right: 1px solid rgba(127,127,127,.15);
      position: sticky; left: 0; z-index: 1; font-size: 11px; font-weight: 600; cursor: pointer; }
    #plexify-modal .px-guide-ch-name:hover { background: rgba(229,160,13,.12); }
    #plexify-modal .px-guide-ch-name img { width: 26px; height: 26px; border-radius: 3px; object-fit: contain;
      background: #000; flex-shrink: 0; }
    #plexify-modal .px-guide-programs { display: flex; flex: 1; min-width: 0; overflow: hidden; }
    #plexify-modal .px-guide-prog { padding: 4px 8px; border-right: 1px solid rgba(127,127,127,.08);
      cursor: pointer; display: flex; flex-direction: column; justify-content: center; overflow: hidden;
      transition: background .15s; }
    #plexify-modal .px-guide-prog:hover { background: rgba(229,160,13,.15); }
    #plexify-modal .px-guide-prog-title { font-size: 11px; font-weight: 600; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    #plexify-modal .px-guide-prog-time { font-size: 9px; color: var(--text-dim, #8992a1); white-space: nowrap; }
    #plexify-modal .px-guide-prog.px-airing { background: rgba(229,160,13,.1); border-left: 2px solid #e5a00d; }
    #plexify-modal .px-guide-loading { padding: 30px; text-align: center; color: var(--text-dim, #8992a1); }
  `

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
          <select id="px-quality" title="Video streaming quality">
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
        renderGrid(itemsFrom(data), route.title)
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

  function renderGrid(items, title) {
    if (state.viewMode === 'list') {
      renderGridList(items, title)
      return
    }
    const root = state.uiDoc.createElement('div')
    if (!items.length) {
      root.innerHTML = `<div class="px-empty">Nothing was found in ${escapeHtml(title)}</div>`
    } else {
      root.className = 'px-grid'
      for (const item of items) root.appendChild(createCard(item))
    }
    setMain(root)
  }

  function renderGridList(items, title) {
    const root = state.uiDoc.createElement('div')
    root.className = 'px-list'
    if (!items.length) {
      root.innerHTML = `<div class="px-empty">Nothing was found in ${escapeHtml(title)}</div>`
    } else {
      for (let i = 0; i < items.length; i++) {
        root.appendChild(createListRow(items[i], i + 1))
      }
    }
    setMain(root)
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
        ratingKey: item.ratingKey
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
        ratingKey: item.ratingKey
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
    // Try /livetv/dvrs first — gives us DVR key + epgIdentifier directly
    try {
      const dvrData = await serverJson('/livetv/dvrs')
      const dvrs = dvrData?.MediaContainer?.Dvr || []
      for (const dvr of dvrs) {
        providers.push({
          id: String(dvr.key),
          title: dvr.friendlyName || dvr.device || `DVR ${dvr.key}`,
          epgIdentifier: dvr.epgIdentifier || '',
          dvrKey: String(dvr.key),
          type: 'dvr'
        })
      }
    } catch { /* no DVRs configured */ }
    // Fallback: try /media/providers for any live-tv capable provider
    if (!providers.length) {
      try {
        const mpData = await serverJson('/media/providers')
        const mps = mpData?.MediaContainer?.MediaProvider || []
        for (const mp of mps) {
          const id = mp.identifier || ''
          if (id.includes('epg') || id.includes('livetv')) {
            providers.push({
              id: id,
              title: mp.title || id,
              epgIdentifier: id,
              dvrKey: '',
              type: 'provider'
            })
          }
        }
      } catch { /* no providers */ }
    }
    return providers
  }

  async function fetchTVChannels(epgIdentifier) {
    if (!state.server || !epgIdentifier) return []
    const data = await serverJson(`/${epgIdentifier}/lineups/dvr/channels`)
    return data?.MediaContainer?.Metadata || []
  }

  async function fetchTVGrid(epgIdentifier, channelKeys, date) {
    if (!state.server || !epgIdentifier || !channelKeys.length) return {}
    const guideData = {}
    // Fetch grid data in batches of 8 channels concurrently
    const batchSize = 8
    for (let i = 0; i < channelKeys.length; i += batchSize) {
      const batch = channelKeys.slice(i, i + batchSize)
      await Promise.all(batch.map(async (chKey) => {
        try {
          const data = await serverJson(`/${epgIdentifier}/grid`, {
            channelGridKey: chKey,
            date: date
          })
          guideData[chKey] = data?.MediaContainer?.Metadata || []
        } catch { guideData[chKey] = [] }
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

    const epgId = state.tvProvider.epgIdentifier
    if (!epgId) {
      showMessage('Could not determine EPG provider identifier. Check DVR setup in Plex.')
      return
    }

    showMessage('Loading channels…')
    let channels = []
    try { 
      channels = await fetchTVChannels(epgId) 
    } catch (e) {
      console.warn('[Plexify] Failed to load channels:', e)
    }
    
    if (nonce !== state.routeNonce) return
    state.tvChannels = channels

    let guideData = {}
    if (channels.length > 0) {
      showMessage(`Loading guide for ${channels.length} channels…`)
      const channelKeys = channels.map(ch => ch.channelIdentifier || ch.guid || '').filter(Boolean)
      try {
        guideData = await fetchTVGrid(epgId, channelKeys.slice(0, 50), state.tvDate)
      } catch (e) {
        console.warn('[Plexify] Failed to load guide data:', e)
      }
    }
    
    if (nonce !== state.routeNonce) return
    state.tvGuideData = guideData

    renderGuideGrid(channels.slice(0, 50), guideData)
  }

  function renderGuideGrid(channels, guideData) {
    const doc = state.uiDoc
    const container = doc.createElement('div')
    container.className = 'px-guide'

    // ── Controls bar ──
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
    provSelect.addEventListener('change', (e) => {
      state.tvProvider = state.tvProviders.find(p => p.id === e.target.value) || state.tvProviders[0]
      void navigate({ type: 'livetv', title: 'Live TV' }, false)
    })

    const prevBtn = doc.createElement('button')
    prevBtn.textContent = '◀'
    prevBtn.title = 'Previous day'
    prevBtn.addEventListener('click', () => {
      const d = new Date(state.tvDate + 'T12:00:00')
      d.setDate(d.getDate() - 1)
      state.tvDate = d.toISOString().slice(0, 10)
      void navigate({ type: 'livetv', title: 'Live TV' }, false)
    })

    const dateLabel = doc.createElement('span')
    dateLabel.className = 'px-guide-date'
    dateLabel.textContent = fmtGuideDate(state.tvDate)

    const nextBtn = doc.createElement('button')
    nextBtn.textContent = '▶'
    nextBtn.title = 'Next day'
    nextBtn.addEventListener('click', () => {
      const d = new Date(state.tvDate + 'T12:00:00')
      d.setDate(d.getDate() + 1)
      state.tvDate = d.toISOString().slice(0, 10)
      void navigate({ type: 'livetv', title: 'Live TV' }, false)
    })

    const todayBtn = doc.createElement('button')
    todayBtn.textContent = 'Today'
    todayBtn.addEventListener('click', () => {
      state.tvDate = new Date().toISOString().slice(0, 10)
      void navigate({ type: 'livetv', title: 'Live TV' }, false)
    })

    const refreshBtn = doc.createElement('button')
    refreshBtn.textContent = '↻ Refresh'
    refreshBtn.addEventListener('click', () => void navigate({ type: 'livetv', title: 'Live TV' }, false))

    controls.append(provSelect, prevBtn, dateLabel, nextBtn, todayBtn, refreshBtn)
    container.appendChild(controls)

    // ── Channel rows ──
    const scrollArea = doc.createElement('div')
    scrollArea.className = 'px-guide-channels'
    const now = Date.now()
    const HOUR_PX = 200

    if (channels.length === 0) {
      const empty = doc.createElement('div')
      empty.className = 'px-guide-loading'
      empty.textContent = 'No channels found for this provider.'
      scrollArea.appendChild(empty)
    }

    for (const ch of channels) {
      const chKey = ch.channelIdentifier || ch.guid || ''
      const programs = guideData[chKey] || []
      const row = doc.createElement('div')
      row.className = 'px-guide-ch-row'

      // Channel name (sticky left)
      const chName = doc.createElement('div')
      chName.className = 'px-guide-ch-name'
      const num = ch.channelNumber || ch.index || ''
      if (ch.thumb) {
        const img = doc.createElement('img')
        img.src = authenticatedUrl(ch.thumb)
        img.alt = ''
        img.loading = 'lazy'
        chName.appendChild(img)
      }
      const nameSpan = doc.createElement('span')
      nameSpan.textContent = num ? `${num} ${ch.title || ''}` : (ch.title || 'Unknown')
      chName.appendChild(nameSpan)
      chName.title = ch.title || ''
      chName.addEventListener('click', () => void tuneLiveChannel(ch))

      // Programs
      const progArea = doc.createElement('div')
      progArea.className = 'px-guide-programs'

      if (programs.length) {
        for (const prog of programs) {
          const startSec = prog.beginsAt || 0
          const endSec = prog.endsAt || (startSec + 1800)
          const startMs = startSec * 1000
          const endMs = endSec * 1000
          const durHours = (endMs - startMs) / 3600000
          const widthPx = Math.max(60, Math.round(durHours * HOUR_PX))

          const el = doc.createElement('div')
          el.className = 'px-guide-prog'
          if (now >= startMs && now < endMs) el.classList.add('px-airing')
          el.style.flex = `0 0 ${widthPx}px`

          const tEl = doc.createElement('div')
          tEl.className = 'px-guide-prog-title'
          tEl.textContent = prog.title || prog.grandparentTitle || '(No Title)'

          const tmEl = doc.createElement('div')
          tmEl.className = 'px-guide-prog-time'
          tmEl.textContent = startSec ? `${fmtGuideTime(startSec)} – ${fmtGuideTime(endSec)}` : ''

          el.append(tEl, tmEl)
          el.title = [prog.title, prog.summary].filter(Boolean).join('\n')
          el.addEventListener('click', () => void tuneLiveChannel(ch))
          progArea.appendChild(el)
        }
      } else {
        const empty = doc.createElement('div')
        empty.className = 'px-guide-prog'
        empty.style.flex = '1'
        const emT = doc.createElement('div')
        emT.className = 'px-guide-prog-title'
        emT.style.color = '#666'
        emT.textContent = 'No guide data'
        empty.appendChild(emT)
        progArea.appendChild(empty)
      }

      row.append(chName, progArea)
      scrollArea.appendChild(row)
    }

    container.appendChild(scrollArea)
    setMain(container)
  }

  async function tuneLiveChannel(channel) {
    if (!state.server) return
    const chId = channel.channelIdentifier || channel.guid || channel.key
    if (!chId) { showToast('No channel identifier found'); return }

    const dvrKey = state.tvProvider?.dvrKey || state.tvProvider?.id || ''
    if (!dvrKey) { showToast('No DVR key available'); return }

    showToast(`Tuning to ${channel.title || chId}…`)

    try {
      // Step 1: Tune the channel
      const tuneUrl = `${state.server.uri}/livetv/dvrs/${encodeURIComponent(dvrKey)}/channels/${encodeURIComponent(chId)}/tune`
      const tuneResp = await ampwin.network.request({
        url: tuneUrl,
        method: 'POST',
        headers: plexHeaders(state.server.token, { Accept: 'application/json' })
      })

      let sessionPath = ''
      try {
        const tuneBody = typeof tuneResp.body === 'string' ? JSON.parse(tuneResp.body) : tuneResp.body
        const meta = tuneBody?.MediaContainer?.Metadata?.[0]
        sessionPath = meta?.key || ''
        if (!sessionPath && meta?.ratingKey) sessionPath = `/livetv/sessions/${meta.ratingKey}`
      } catch {
        // If JSON parse fails, try to extract session from XML-like response
        const match = typeof tuneResp.body === 'string' && tuneResp.body.match(/key="([^"]*livetv\/sessions\/[^"]*)"/)
        if (match) sessionPath = match[1]
      }

      if (!sessionPath) {
        showToast('Tune failed — no session returned. Check Plex DVR logs.')
        return
      }

      // Step 2: Build transcoded stream URL
      const q = QUALITY_MAP[state.videoQuality] || QUALITY_MAP['720p']
      const streamUrl = new URL('/video/:/transcode/universal/start.mp4', `${state.server.uri}/`)
      streamUrl.searchParams.set('path', sessionPath)
      streamUrl.searchParams.set('mediaIndex', '0')
      streamUrl.searchParams.set('partIndex', '0')
      streamUrl.searchParams.set('protocol', 'http')
      streamUrl.searchParams.set('offset', '0')
      streamUrl.searchParams.set('fastSeek', '1')
      streamUrl.searchParams.set('directPlay', '0')
      streamUrl.searchParams.set('directStream', '1')
      streamUrl.searchParams.set('directStreamAudio', '0')
      streamUrl.searchParams.set('videoQuality', '100')
      streamUrl.searchParams.set('maxVideoBitrate', String(q.bitrate))
      streamUrl.searchParams.set('videoResolution', q.resolution)
      streamUrl.searchParams.set('audioBoost', '100')
      streamUrl.searchParams.set('location', 'lan')
      streamUrl.searchParams.set('subtitles', 'burn')
      streamUrl.searchParams.set('hasMDE', '1')
      streamUrl.searchParams.set('autoAdjustQuality', '0')
      streamUrl.searchParams.set('X-Plex-Session-Identifier', crypto.randomUUID())
      streamUrl.searchParams.set('X-Plex-Platform', 'Chrome')
      streamUrl.searchParams.set('X-Plex-Token', state.server.token)
      streamUrl.searchParams.set('X-Plex-Client-Identifier', clientId)
      streamUrl.searchParams.set('X-Plex-Product', PRODUCT)

      const url = streamUrl.toString()
      const title = `📺 ${channel.title || chId}`
      const thumb = channel.thumb ? authenticatedUrl(channel.thumb) : ''

      // Step 3: Play via addSearchResult
      const result = { url, title, durationSec: 0, uploader: 'Live TV', thumbnail: thumb }
      const track = ampwin.links.addSearchResult(result, false)
      ampwin.links.play(track)
      showToast(`Now watching: ${channel.title || chId}`)
    } catch (err) {
      console.error('[Plexify] Tune failed:', err)
      showToast(`Failed to tune: ${err?.message || err}`)
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
    const url = new URL('/video/:/transcode/universal/start.mp4', `${state.server.uri}/`)
    url.searchParams.set('path', `/library/metadata/${full.ratingKey}`)
    url.searchParams.set('mediaIndex', '0')
    url.searchParams.set('partIndex', '0')
    url.searchParams.set('protocol', 'http')
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
    url.searchParams.set('X-Plex-Session-Identifier', crypto.randomUUID())
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
    // For video content, use server-side transcoding unless user chose 'original'
    const path = (audioOnly || state.videoQuality === 'original') ? directPath : transcodedUrl(full)
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

  function boot() {
    // The launch button is always installed. Missing host capabilities are
    // reported inside Plexify instead of making the addon appear to do nothing.
    installIntoSkin()
    if (!ampwin.network?.request) console.warn('Plexify: ampwin.network.request is unavailable')
    setTimeout(() => {
      const doc = currentSkinDocument()
      if (!doc?.getElementById('plexify-launch')) installHostFallback()
    }, 300)
    try {
      const layer = window.parent.document.getElementById('skin-layer')
      if (layer) {
        state.observer = new MutationObserver(() => setTimeout(installIntoSkin, 0))
        state.observer.observe(layer, { childList: true, subtree: true })
      }
    } catch (error) {
      console.error('Plexify could not observe skin changes', error)
      installHostFallback()
    }
  }

  window.addEventListener('unload', () => {
    state.observer?.disconnect()
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
