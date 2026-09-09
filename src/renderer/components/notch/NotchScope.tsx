import { useEffect, useRef } from 'react'
import { isNativeAvailable, oscilloscope, OSCILLOSCOPE_BUFFER_SIZE, spectrum } from '../../audio/native'
import { getNormalizedOscilloscopeDisplaySamples, OSCILLOSCOPE_VISUAL_GAIN } from '../../audio/native/oscilloscopeDisplaySamples'
import { fillNotchSpectrum, notchOscilloscopeGain, notchOscilloscopeY, NOTCH_SPECTRUM_FFT_SIZE, NOTCH_SCOPE_WARMUP_SAMPLES, smoothNotchSpectrum } from './notchVisualizer'

export default function NotchScope({ mode, active, color, frozen, width, height }: {
  mode: 'oscilloscope' | 'spectrum'; active: boolean; color: string; frozen: boolean; width: number; height: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    // Preserve the outgoing frame while metadata crossfades over it. Cleanup
    // stops both the subscription and any in-flight smoothing animation.
    if (frozen || width < 2) return
    const canvas = canvasRef.current!
    const ctx = canvas.getContext('2d')!
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr)
    ctx.scale(dpr, dpr)
    let frame = 0, lastFrame = 0, samplesReceived = 0
    let scopeGain = OSCILLOSCOPE_VISUAL_GAIN, lastScopeFrame = 0
    let data: Float32Array | null = null, pending: Float32Array[] = []
    let sampleRate = 0, pitchLock: boolean | null = null
    let scratch = new Float32Array(0)
    const spectrumTarget = new Float32Array(Math.ceil(width * dpr) + 1)
    const spectrumDisplay = new Float32Array(spectrumTarget.length)
    const fill = ctx.createLinearGradient(0, 0, 0, height)
    fill.addColorStop(0, color); fill.addColorStop(1, 'transparent')
    const reset = () => {
      pending = []; data = null; samplesReceived = 0
      scopeGain = OSCILLOSCOPE_VISUAL_GAIN; lastScopeFrame = 0
      spectrumTarget.fill(0); spectrumDisplay.fill(0)
      if (mode === 'oscilloscope') oscilloscope.reset(); else spectrum.reset()
    }
    const draw = (now: number) => {
      frame = 0
      if (pending.length) {
        const count = pending.reduce((sum, chunk) => sum + chunk.length, 0)
        if (scratch.length < count) scratch = new Float32Array(count)
        let offset = 0
        for (const chunk of pending) { scratch.set(chunk, offset); offset += chunk.length }
        pending = []
        const samples = scratch.subarray(0, count)
        if (mode === 'oscilloscope') {
          oscilloscope.pushSamples(samples)
          samplesReceived += count
          if (!pitchLock || samplesReceived >= NOTCH_SCOPE_WARMUP_SAMPLES) {
            const result = oscilloscope.processContinuous()
            if (result) {
              const start = pitchLock ? result.triggerIndex
                : (result.writePos - result.samplesToShow + OSCILLOSCOPE_BUFFER_SIZE) % OSCILLOSCOPE_BUFFER_SIZE
              // Preserve the native trigger's sub-sample precision.
              data = oscilloscope.getSamples(start, result.samplesToShow)
              if (data) scopeGain = notchOscilloscopeGain(data, scopeGain, lastScopeFrame ? now - lastScopeFrame : 1000 / 60)
              lastScopeFrame = now
            }
          }
        } else {
          const frequencyData = spectrum.process(samples)
          if (frequencyData) fillNotchSpectrum(frequencyData, sampleRate, spectrumTarget)
        }
      }
      const moving = mode === 'spectrum' && smoothNotchSpectrum(spectrumDisplay, spectrumTarget, lastFrame ? now - lastFrame : 1000 / 60)
      lastFrame = now
      ctx.clearRect(0, 0, width, height)
      ctx.strokeStyle = color; ctx.lineWidth = 1.05; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
      ctx.globalAlpha = active ? 0.95 : 0.35
      ctx.beginPath()
      if (mode === 'oscilloscope' && data?.length && active) {
        // Draw every sample, as the main scope does. Striding over samples at
        // this width discards brief peaks and aliases high-frequency detail.
        for (let i = 0; i < data.length; i++) {
          const x = i * width / Math.max(1, data.length - 1)
          const y = notchOscilloscopeY(data[i], height, scopeGain)
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        }
      } else if (mode === 'spectrum' && active) {
        for (let i = 0; i < spectrumDisplay.length; i++) {
          const x = i * width / (spectrumDisplay.length - 1)
          const y = height - 1 - spectrumDisplay[i] * (height - 2)
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
        }
      } else {
        const baseline = mode === 'oscilloscope' ? height / 2 : height - 1
        ctx.moveTo(0, baseline); ctx.lineTo(width, baseline)
      }
      ctx.stroke()
      if (mode === 'spectrum' && active) {
        ctx.lineTo(width, height); ctx.lineTo(0, height); ctx.closePath()
        ctx.globalAlpha = 0.18; ctx.fillStyle = fill; ctx.fill()
      }
      if (moving) frame = requestAnimationFrame(draw)
      else lastFrame = 0
    }
    draw(performance.now())
    if (!active || !isNativeAvailable()) return
    reset()
    if (mode === 'spectrum') {
      spectrum.setFFTSize(NOTCH_SPECTRUM_FFT_SIZE)
      // Smooth on animation frames; native per-push smoothing depends on
      // how many chunks happened to arrive together over IPC.
      spectrum.setSmoothing(0)
    }
    const unsubscribe = window.electronAPI.notch.onVisualizerChunk(chunk => {
      if (chunk.reset) reset()
      else {
        if (sampleRate !== chunk.sampleRate) {
          reset()
          sampleRate = chunk.sampleRate
          if (mode === 'oscilloscope') {
            oscilloscope.setSampleRate(sampleRate)
            oscilloscope.setDisplaySamples(getNormalizedOscilloscopeDisplaySamples(sampleRate))
          } else spectrum.setSampleRate(sampleRate)
        }
        if (mode === 'oscilloscope' && pitchLock !== chunk.pitchLock) {
          pitchLock = chunk.pitchLock; oscilloscope.setPitchLock(pitchLock)
        }
        pending.push(...(mode === 'oscilloscope' ? chunk.leftChunks : chunk.monoChunks))
        if (pending.length > 24) pending = pending.slice(-24)
      }
      if (!frame) frame = requestAnimationFrame(draw)
    })
    return () => { unsubscribe(); cancelAnimationFrame(frame); reset() }
  }, [mode, active, color, frozen, width, height])
  return <canvas ref={canvasRef} className="notch-scope" style={{ height }} aria-hidden="true" />
}
