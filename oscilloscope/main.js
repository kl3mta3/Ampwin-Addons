// Oscilloscope — a reference Ampwin addon.
//
// An addon runs headless (no visible document) with the full window.ampwin API,
// exactly like a skin. This one registers a VisualizerPlugin that draws the
// live audio waveform. It works whether Ampwin is playing its own file or is in
// System-audio mode — the plugin reads whatever `sourceNode` carries.
//
// The plugin interface (see ampwin.visualizer.registerPlugin):
//   id, name
//   init(ctx)   ctx = { canvas, audioContext, sourceNode, analyser }
//   render(frame)   frame = { elapsedMs, frameCount }   — once per animation frame
//   resize(w, h)
//   destroy()   — disconnect anything you connected in init()
/* global ampwin */
;(() => {
  'use strict'

  let g2d = null
  let analyser = null
  let buf = null
  let width = 0
  let height = 0

  ampwin.visualizer.registerPlugin({
    id: 'oscilloscope',
    name: 'Oscilloscope',

    init(ctx) {
      g2d = ctx.canvas.getContext('2d')
      width = ctx.canvas.width
      height = ctx.canvas.height

      // Our own analyser tapping the shared source — time-domain (waveform).
      analyser = ctx.audioContext.createAnalyser()
      analyser.fftSize = 2048
      buf = new Uint8Array(analyser.fftSize)
      ctx.sourceNode.connect(analyser)
    },

    render() {
      if (!g2d || !analyser) return
      analyser.getByteTimeDomainData(buf)

      // Fade the previous frame slightly for a phosphor-trail look.
      g2d.fillStyle = 'rgba(0, 0, 0, 0.28)'
      g2d.fillRect(0, 0, width, height)

      g2d.lineWidth = 2
      g2d.strokeStyle = '#3fdf6f'
      g2d.shadowColor = '#3fdf6f'
      g2d.shadowBlur = 6
      g2d.beginPath()

      const step = width / buf.length
      let x = 0
      for (let i = 0; i < buf.length; i++) {
        const v = buf[i] / 128 - 1 // -1 .. 1
        const y = height / 2 + v * (height / 2) * 0.9
        if (i === 0) g2d.moveTo(x, y)
        else g2d.lineTo(x, y)
        x += step
      }
      g2d.stroke()
      g2d.shadowBlur = 0
    },

    resize(w, h) {
      width = w
      height = h
    },

    destroy() {
      try {
        analyser.disconnect()
      } catch (e) {
        /* already gone */
      }
      analyser = null
      buf = null
      g2d = null
    }
  })
})()
