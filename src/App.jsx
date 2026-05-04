import { useState, useRef, useEffect, useCallback } from 'react'
import { marked } from 'marked'
import Waveform from './Waveform'

marked.setOptions({ breaks: true, gfm: true })

const GROQ      = 'https://api.groq.com/openai/v1'
const LLM_MODEL = 'llama-3.3-70b-versatile'

const SYSTEM_PROMPT = `You are a voice-to-markdown formatter. Convert spoken text into clean, well-structured Markdown, applying any formatting commands the user mentions naturally in speech.

Recognize these voice commands:
- "write in points / bullet points / as a list" → - item
- "numbered list / numbered points / step by step" → 1. 2. 3.
- "heading / main heading / title" → # Heading
- "sub heading / subheading / section" → ## Sub
- "bold [text] / make [text] bold" → **text**
- "italic [text]" → *text*
- "remove [phrase] / delete [phrase] / cut [phrase]" → omit it
- "new paragraph" → blank line
- "code block / in code" → \`\`\`code\`\`\`
- "inline code" → \`code\`
- "blockquote / as a quote" → > text
- "separator / horizontal rule" → ---
- "table with columns X Y Z" → markdown table
- "add to / continue / extend the list" → append items

When an existing document and new instruction is provided, apply the modification.
Return ONLY the final Markdown — no preamble, no explanation, no surrounding code fences.`

export default function App() {
  const [apiKey,    setApiKey]   = useState(() => localStorage.getItem('groq_key') ?? '')
  const [showKey,   setShowKey]  = useState(false)
  const [mode,      setMode]     = useState('append')
  const [recording, setRecording] = useState(false)
  const [liveText,  setLiveText] = useState('')
  const [markdown,  setMarkdown] = useState('')
  const [forming,   setForming]  = useState(false)   // LLM is streaming
  const [error,     setError]    = useState('')
  const [copied,    setCopied]   = useState('')
  const [analyser,  setAnalyser] = useState(null)

  const recRef      = useRef(null)   // SpeechRecognition
  const streamRef   = useRef(null)   // mic stream (for waveform)
  const audioCtxRef = useRef(null)
  const abortRef    = useRef(null)   // AbortController for in-flight LLM
  const debounceRef = useRef(null)
  const mdRef       = useRef('')     // live mirror for closures
  const outputRef   = useRef(null)

  const saveKey = (v) => { setApiKey(v); localStorage.setItem('groq_key', v) }

  /* ── Format with Groq (called on every debounce tick) ── */
  const formatLive = useCallback(async (transcript, signal) => {
    const key = localStorage.getItem('groq_key') ?? ''
    if (!key || !transcript.trim()) return

    const userContent =
      mode === 'append' && mdRef.current
        ? `Current document:\n${mdRef.current}\n\nNew voice instruction: ${transcript}`
        : transcript

    setForming(true)
    try {
      const res = await fetch(`${GROQ}/chat/completions`, {
        signal,
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LLM_MODEL,
          stream: true,
          max_tokens: 2048,
          temperature: 0.1,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user',   content: userContent },
          ],
        }),
      })
      if (!res.ok) throw new Error(`LLM ${res.status}`)

      const reader = res.body.getReader()
      const dec    = new TextDecoder()
      let buf = ''
      let md  = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ') || line.includes('[DONE]')) continue
          try {
            const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta?.content
            if (delta) {
              md += delta
              mdRef.current = md
              setMarkdown(md)
              outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' })
            }
          } catch { /* skip bad chunk */ }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message)
    } finally {
      setForming(false)
    }
  }, [mode])

  /* ── Debounce: cancel prev LLM + schedule new one ── */
  const scheduleFormat = useCallback((transcript) => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      abortRef.current?.abort()
      abortRef.current = new AbortController()
      formatLive(transcript, abortRef.current.signal)
    }, 700)
  }, [formatLive])

  /* ── Start ── */
  const start = useCallback(async () => {
    const key = apiKey.trim()
    if (!key) { setShowKey(true); setError('Enter your Groq API key first.'); return }

    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!SR) { setError('Speech recognition requires Chrome or Edge.'); return }

    setError('')

    // Mic stream purely for waveform
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const ctx     = new AudioContext()
      const src     = ctx.createMediaStreamSource(stream)
      const node    = ctx.createAnalyser()
      node.fftSize  = 1024
      node.smoothingTimeConstant = 0.82
      src.connect(node)
      audioCtxRef.current = ctx
      setAnalyser(node)
    } catch {
      setError('Microphone access denied.')
      return
    }

    // Speech recognition for live transcript
    const rec = new SR()
    rec.continuous     = true
    rec.interimResults = true
    rec.onresult = (e) => {
      let text = ''
      for (const r of e.results) text += r[0].transcript
      setLiveText(text)
      scheduleFormat(text)
    }
    rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') setError(e.error) }
    rec.onend = () => {
      // auto-restart if still in recording state (browser cuts off after ~60s)
      if (recRef.current === rec) rec.start()
    }
    rec.start()
    recRef.current = rec
    setRecording(true)
    setLiveText('')
  }, [apiKey, scheduleFormat])

  /* ── Stop ── */
  const stop = useCallback(() => {
    clearTimeout(debounceRef.current)
    abortRef.current?.abort()

    const rec = recRef.current
    if (rec) {
      rec.onend = null   // prevent auto-restart
      rec.stop()
      recRef.current = null
    }

    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    audioCtxRef.current?.close()
    audioCtxRef.current = null
    setAnalyser(null)
    setRecording(false)
    setForming(false)
  }, [])

  const clear = () => {
    stop()
    setMarkdown(''); setLiveText(''); setError('')
    mdRef.current = ''
  }

  const copy = async (what) => {
    const text = what === 'md'
      ? mdRef.current
      : document.getElementById('md-out')?.innerText ?? ''
    await navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(''), 1600)
  }

  // Space shortcut
  useEffect(() => {
    const h = (e) => {
      if (e.code !== 'Space' || ['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) return
      e.preventDefault()
      recording ? stop() : start()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [recording, start, stop])

  const html = markdown ? marked.parse(markdown) : ''

  return (
    <div className="flex flex-col h-screen bg-[#07071f] text-slate-100 font-sans overflow-hidden"
         style={{ backgroundImage: 'radial-gradient(ellipse 70% 50% at 15% 5%, rgba(76,29,149,0.2) 0%,transparent 70%), radial-gradient(ellipse 55% 45% at 85% 95%, rgba(12,74,110,0.15) 0%,transparent 70%)' }}>

      {/* ── Header ── */}
      <header className="flex-shrink-0 h-[52px] flex items-center justify-between px-5 border-b border-white/[0.07] bg-[#07071f]/90 backdrop-blur-xl z-20">
        <div className="flex items-center gap-2.5 select-none">
          <span className="w-2.5 h-2.5 rounded-full bg-violet-500 shadow-[0_0_10px_rgba(139,92,246,0.8)]" />
          <span className="text-[17px] font-bold tracking-tight">
            Voice<span className="text-violet-400">MD</span>
          </span>
        </div>

        {/* Mode toggle */}
        <div className="absolute left-1/2 -translate-x-1/2 flex bg-white/[0.04] border border-white/[0.07] rounded-lg p-[3px] gap-0.5">
          {['append','replace'].map(m => (
            <button key={m}
              onClick={() => setMode(m)}
              className={`px-4 py-1 rounded-md text-[12px] font-medium transition-all ${
                mode === m
                  ? 'bg-violet-500/20 text-slate-100 shadow-[0_0_12px_rgba(139,92,246,0.25)]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}>
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {markdown && (
            <button onClick={clear}
              className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-slate-400 border border-white/[0.07] hover:text-red-400 hover:border-red-500/40 transition-all">
              Clear
            </button>
          )}
          <button onClick={() => setShowKey(v => !v)}
            className={`px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-all ${
              showKey ? 'border-violet-500/50 text-violet-400' : 'border-white/[0.07] text-slate-400 hover:text-slate-200'
            }`}>
            ⚙ API Key
          </button>
        </div>
      </header>

      {/* ── API Key drawer ── */}
      {showKey && (
        <div className="flex-shrink-0 flex items-center gap-3 px-5 py-2.5 bg-violet-500/[0.06] border-b border-violet-500/30 animate-[slideDown_0.15s_ease]">
          <span className="text-[12px] text-slate-400 font-medium whitespace-nowrap">Groq API Key</span>
          <input type="password" placeholder="gsk_..."
            value={apiKey} onChange={e => saveKey(e.target.value)}
            autoFocus spellCheck={false}
            className="flex-1 max-w-sm bg-white/[0.04] border border-white/[0.07] focus:border-violet-500/50 rounded-lg px-3 py-1.5 text-[13px] font-mono text-slate-100 outline-none transition-colors" />
          <button onClick={() => setShowKey(false)}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-slate-400 border border-white/[0.07] hover:text-slate-200 transition-all">
            Done
          </button>
        </div>
      )}

      {/* ── Split ── */}
      <div className="flex-1 grid grid-cols-[1fr_1px_1fr] min-h-0">

        {/* ── Left: Output ── */}
        <div className="flex flex-col min-h-0">
          <div className="flex-shrink-0 flex items-center justify-between px-5 h-11 border-b border-white/[0.06] bg-white/[0.015]">
            <span className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Output</span>
            {markdown && (
              <div className="flex gap-1.5">
                <button onClick={() => copy('md')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-all ${
                    copied === 'md' ? 'border-emerald-500/40 text-emerald-400' : 'border-white/[0.07] text-slate-400 hover:text-slate-200'
                  }`}>
                  {copied === 'md' ? '✓ Copied' : 'Copy MD'}
                </button>
                <button onClick={() => copy('text')}
                  className={`px-2.5 py-1 rounded-md text-[11px] font-medium border transition-all ${
                    copied === 'text' ? 'border-emerald-500/40 text-emerald-400' : 'border-white/[0.07] text-slate-400 hover:text-slate-200'
                  }`}>
                  {copied === 'text' ? '✓ Copied' : 'Copy Text'}
                </button>
              </div>
            )}
          </div>

          <div ref={outputRef} className="flex-1 overflow-y-auto px-8 py-7 flex flex-col gap-5">
            {/* Empty state */}
            {!markdown && !liveText && !recording && (
              <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center pb-16">
                <div className="w-14 h-14 rounded-full border border-violet-500/40 shadow-[0_0_28px_rgba(139,92,246,0.2),inset_0_0_20px_rgba(139,92,246,0.1)] animate-breathe" />
                <p className="text-[15px] font-semibold text-slate-400">Start speaking</p>
                <p className="text-[13px] text-slate-600 leading-relaxed max-w-xs">
                  Say{' '}
                  <em className="not-italic text-slate-400 border-b border-dashed border-slate-600">"write in points"</em>,{' '}
                  <em className="not-italic text-slate-400 border-b border-dashed border-slate-600">"make it a heading"</em>,{' '}
                  <em className="not-italic text-slate-400 border-b border-dashed border-slate-600">"bold that"</em>…
                </p>
                <p className="text-[12px] text-slate-600">Markdown updates live as you speak</p>
              </div>
            )}

            {/* Live text */}
            {(recording || liveText) && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold tracking-widest border ${
                    recording
                      ? 'bg-red-500/10 border-red-500/30 text-red-400 animate-pulse'
                      : 'bg-white/[0.04] border-white/[0.07] text-slate-500'
                  }`}>
                    {recording ? '● LIVE' : 'TRANSCRIPT'}
                  </span>
                  {forming && (
                    <span className="flex items-center gap-1.5 text-[11px] text-amber-400 font-medium">
                      <span className="w-3 h-3 rounded-full border-2 border-amber-400/30 border-t-amber-400 animate-spin" />
                      Formatting…
                    </span>
                  )}
                </div>
                <p className="text-[14px] text-slate-400 italic leading-relaxed">
                  {liveText || <span className="text-slate-600">Listening…</span>}
                  {recording && <span className="inline-block w-0.5 h-[1em] bg-violet-400 ml-0.5 align-text-bottom rounded-sm animate-[cursorBlink_0.85s_step-start_infinite]" />}
                </p>
              </div>
            )}

            {/* Markdown */}
            {markdown && (
              <div id="md-out"
                className={`prose prose-invert prose-sm max-w-none prose-violet prose-headings:font-bold prose-code:font-mono ${forming ? 'after:content-[""] after:inline-block after:w-0.5 after:h-[1em] after:bg-violet-400 after:ml-0.5 after:align-text-bottom after:rounded-sm after:animate-[cursorBlink_0.85s_step-start_infinite]' : ''}`}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}

            {/* Error */}
            {error && (
              <div className="px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-[13px]">
                {error}
              </div>
            )}
          </div>
        </div>

        {/* ── Divider ── */}
        <div className="relative bg-white/[0.06]">
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-violet-500/60 to-transparent" />
        </div>

        {/* ── Right: Waveform + Record ── */}
        <div className="flex flex-col min-h-0">
          <div className="flex-shrink-0 flex items-center justify-between px-5 h-11 border-b border-white/[0.06] bg-white/[0.015]">
            <span className="text-[11px] font-semibold tracking-widest text-slate-500 uppercase">Voice Input</span>
            <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold border transition-all duration-300 ${
              recording ? 'bg-red-500/10 border-red-500/30 text-red-400 animate-pulse'
              : forming  ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
              : markdown  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : 'bg-white/[0.04] border-white/[0.07] text-slate-500'
            }`}>
              {recording ? '● Live' : forming ? '◌ Formatting' : markdown ? '✓ Done' : 'Ready'}
            </span>
          </div>

          {/* Waveform */}
          <div className="flex-1 min-h-0 px-7 py-6">
            <Waveform analyser={analyser} isRecording={recording} />
          </div>

          {/* Record button */}
          <div className="flex-shrink-0 flex flex-col items-center gap-3 pb-8">
            <button
              onClick={recording ? stop : start}
              aria-label={recording ? 'Stop' : 'Start recording'}
              className={`relative w-16 h-16 rounded-full border-2 flex items-center justify-center transition-all duration-200 ${
                recording
                  ? 'border-red-500 bg-red-500/10 text-red-400 shadow-[0_0_32px_rgba(239,68,68,0.35)] animate-[pulseRed_1.8s_ease-in-out_infinite]'
                  : 'border-white/20 bg-white/[0.03] text-slate-400 hover:border-violet-500 hover:text-violet-400 hover:shadow-[0_0_28px_rgba(139,92,246,0.35)]'
              }`}>
              {recording ? (
                <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
                  <rect x="6" y="6" width="12" height="12" rx="2.5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
                  <rect x="9" y="2" width="6" height="13" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                  <line x1="8"  y1="22" x2="16" y2="22" />
                </svg>
              )}
              {/* Pulse ring */}
              {recording && (
                <span className="absolute inset-[-6px] rounded-full border border-red-500/30 animate-[ringPulse_1.8s_ease-in-out_infinite]" />
              )}
            </button>
            <p className="text-[12px] text-slate-600">
              press <kbd className="bg-white/[0.06] border border-white/[0.1] rounded px-1.5 py-0.5 text-[10px] font-mono text-slate-400">Space</kbd> or click
            </p>
          </div>
        </div>

      </div>
    </div>
  )
}
