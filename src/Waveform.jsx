import { useEffect, useRef } from 'react'

const BAR_COUNT       = 80
const VOICE_BIN_RATIO = 0.5

export default function Waveform({ analyser, isRecording }) {
  const canvasRef = useRef(null)
  const rafRef    = useRef(null)
  const t0        = useRef(Date.now())

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx    = canvas.getContext('2d')

    function sync() {
      const dpr = window.devicePixelRatio || 1
      const { offsetWidth: w, offsetHeight: h } = canvas
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width  = w * dpr
        canvas.height = h * dpr
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
    }

    const ro = new ResizeObserver(sync)
    ro.observe(canvas)
    sync()

    function draw() {
      rafRef.current = requestAnimationFrame(draw)
      sync()

      const W   = canvas.offsetWidth
      const H   = canvas.offsetHeight
      const gap = 3
      const barW = (W - gap * (BAR_COUNT - 1)) / BAR_COUNT

      ctx.shadowBlur = 0
      ctx.clearRect(0, 0, W, H)

      if (analyser && isRecording) {
        const data = new Uint8Array(analyser.frequencyBinCount)
        analyser.getByteFrequencyData(data)
        const step = Math.floor((analyser.frequencyBinCount * VOICE_BIN_RATIO) / BAR_COUNT)

        ctx.shadowBlur = 18
        for (let i = 0; i < BAR_COUNT; i++) {
          const v = (data[i * step] + (data[i * step + 1] ?? 0)) / 2 / 255
          const h = Math.max(v * H * 0.88, 3)
          const x = i * (barW + gap)
          const y = (H - h) / 2

          // violet (#8b5cf6) → cyan (#22d3ee) by amplitude
          const r = Math.round(139 - v * 105)
          const g = Math.round(92  + v * 119)
          const b = Math.round(246 - v * 8)

          ctx.shadowColor = `rgba(${r},${g},${b},0.65)`
          ctx.fillStyle   = `rgba(${r},${g},${b},${0.6 + v * 0.4})`

          ctx.beginPath()
          if (ctx.roundRect) ctx.roundRect(x, y, barW, h, Math.min(barW / 2, 4))
          else ctx.rect(x, y, barW, h)
          ctx.fill()
        }
      } else {
        // Idle: slow sine shimmer
        const t = (Date.now() - t0.current) / 1000
        ctx.shadowBlur  = 8
        ctx.shadowColor = 'rgba(139,92,246,0.45)'

        for (let i = 0; i < BAR_COUNT; i++) {
          const phase = (i / BAR_COUNT) * Math.PI * 5 + t * 1.8
          const v = Math.sin(phase) * 0.09 + 0.07
          const h = Math.max(v * H, 2)
          const x = i * (barW + gap)
          const y = (H - h) / 2

          ctx.fillStyle = `rgba(139,92,246,${0.15 + v * 1.4})`
          ctx.beginPath()
          if (ctx.roundRect) ctx.roundRect(x, y, barW, h, 2)
          else ctx.rect(x, y, barW, h)
          ctx.fill()
        }
      }
    }

    draw()
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect() }
  }, [analyser, isRecording])

  return <canvas ref={canvasRef} className="w-full h-full block" />
}
