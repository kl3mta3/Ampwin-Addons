# Ampwin Addons

The addon repository for [Ampwin](https://github.com/kl3mta3/Ampwin). Ampwin's
**🧩 addons** button reads `index.json` from the root of this repo, shows a
filterable list, and installs the addon you pick — no app update needed. Add a
new addon by pushing a folder and adding one entry to `index.json`.

> The default repo URL is `https://github.com/kl3mta3/Ampwin-Addons`.
> The **contents of this `addons-repo/` folder go at the root** of that repo.

## Repository layout

```
/  (repo root)
├── index.json            ← the catalog Ampwin fetches
├── oscilloscope/         ← one folder per addon (folder name === addon id)
│   ├── addon.json        ← manifest
│   └── main.js           ← entry script
└── <your-addon>/
    ├── addon.json
    └── main.js
```

Ampwin downloads files over `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<id>/<file>`
(branch `main`, falling back to `master`).

## `index.json`

```json
{
  "addons": [
    {
      "id": "oscilloscope",
      "name": "Oscilloscope",
      "version": "1.0.0",
      "description": "Classic green waveform scope.",
      "author": "kl3mta3",
      "entry": "main.js",
      "files": ["addon.json", "main.js"]
    }
  ]
}
```

- `id` — lowercase letters, digits, hyphens; **must match the folder name**.
- `files` — every file to download when installing (relative paths, no `..`).
  List the entry script and anything it loads (extra JS, images, etc.).

## `addon.json` (manifest)

```json
{
  "apiVersion": 1,
  "id": "oscilloscope",
  "name": "Oscilloscope",
  "version": "1.0.0",
  "description": "Classic green waveform scope.",
  "author": "kl3mta3",
  "entry": "main.js"
}
```

## Writing an addon

An addon is plain JavaScript that runs headless with the **full `window.ampwin`
API** — the same object skins get. Most addons register a visualizer:

```js
ampwin.visualizer.registerPlugin({
  id: 'my-viz',
  name: 'My Visualizer',
  init(ctx) {
    // ctx = { canvas, audioContext, sourceNode, analyser }
    // sourceNode is the audio being visualized — the app's own playback, or
    // the whole system's output when System-audio mode is on.
  },
  render(frame) {
    /* frame = { elapsedMs, frameCount } — called once per animation frame */
  },
  resize(w, h) {},
  destroy() {
    /* disconnect any audio nodes you connected in init() */
  }
})
```

The addon's visualizer appears in the visualizer dropdown and **stays available
across skin switches**. Disabling or uninstalling the addon removes it and its
plugins cleanly.

Addons can use any part of `ampwin` (player, playlist, files, links, convert,
system, addons, …), so they're not limited to visualizers — but keep them small
and self-contained.

See `oscilloscope/main.js` for a complete, working example.
