import { useState, useRef, useEffect, useCallback } from 'react'
import { marked } from 'marked'
import Waveform from './Waveform'

marked.setOptions({ breaks: true, gfm: true })

const GROQ        = 'https://api.groq.com/openai/v1'
const STT_MODEL   = 'whisper-large-v3-turbo'
const LLM_MODEL   = 'llama-3.3-70b-versatile'
const SYSTEM_PROMPT = `You are a voice-to-markdown formatter. Convert spoken text into clean, well-structured Markdown, applying any formatting commands the user mentions naturally in speech.

Recognize these voice commands:
- "write in points / bullet points / as a list / list format" → - item
- "numbered list / numbered points / step by step / serial" → 1. 2. 3.
- "heading / main heading / title" → # Heading
- "sub heading / subheading / section" → ## Sub
- "bold [text] / make [text] bold / highlight [text]" → **text**
- "italic [text] / italicize" → *text*
- "remove [phrase] / delete [phrase] / cut [phrase] / strike that" → omit it
- "new paragraph / next paragraph" → blank line
- "code block / in code" → \`\`\`lang\\ncode\\n\`\`\`
- "inline code" → \`code\`
- "quote / blockquote / as a quote" → > text
- "separator / divider / horizontal rule" → ---
- "table with columns X Y Z" → markdown table
- "add to / continue / extend the list" → append items to existing structure

When an existing document is provided with a new instruction, apply the modification precisely.
Return ONLY the final Markdown — no preamble, no explanation, no surrounding code fences.`

function getSupportedMime() {
  return (
    ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(m => MediaRecorder.isTypeSupported(m)) ?? ''
  )
}

export default function App() {
  const [apiKey,       setApiKey]      = useState(() => localStorage.getItem('groq_key') ?? '')
  const [showKey,      setShowKey]     = useState(false)
  const [mode,         setMode]        = useState('append')   // append | replace
  const [status,       setStatus]      = useState('idle')     // idle|recording|transcribing|formatting|done|error
  const [liveText,     setLiveText]    = useState('')
  const [transcript,   setTranscript]  = useState('')
  const [markdown,     setMarkdown]    = useState('')
  const [errorMsg,     setErrorMsg]    = useState('')
  const [analyser,     setAnalyser]    = useState(null)
  const [copied,       setCopied]      = useState('')         // 'md' | 'text' | ''

  const mrRef       = useRef(null)
  const audioCtxRef = useRef(null)
  const chunksRef   = useRef([])
  const recRef      = useRef(null)   // SpeechRecognition
  const mdRef       = useRef('')     // live mirror of markdown state for closures
  const outputRef   = useRef(null)

  const isRecording = status === 'recording'
  const isBusy      = status === 'transcribing' || status === 'formatting'

  const saveKey = (v) => {
    setApiKey(v)
    localStorage.setItem('groq_key', v)
  }

  /* ── Start recording ── */
  const startRecording = useCallback(async () => {
    const key = apiKey.trim()
    if (!key) {
      setShowKey(true)
      setErrorMsg('Enter your Groq API key first.')
      return
    }
    setErrorMsg('')
    setLiveText('')

    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setErrorMsg('Microphone access denied.')
      setStatus('error')
      return
    }

    // Web Audio → AnalyserNode for waveform
    const audioCtx    = new AudioContext()
    const srcNode     = audioCtx.createMediaStreamSource(stream)
    const analyserNode = audioCtx.createAnalyser()
    analyserNode.fftSize = 1024
    analyserNode.smoothingTimeConstant = 0.82
    srcNode.connect(analyserNode)
    audioCtxRef.current = audioCtx
    setAnalyser(analyserNode)

    // MediaRecorder for Groq Whisper
    chunksRef.current = []
    const mime = getSupportedMime()
    const mr   = new MediaRecorder(stream, mime ? { mimeType: mime } : {})
    mr.ondataavailable = e => e.data?.size && chunksRef.current.push(e.data)
    mr.onstop = () => {
      stream.getTracks().forEach(t => t.stop())
      audioCtxRef.current?.close()
      setAnalyser(null)
      processAudio(key)
    }
    mr.start(100)
    mrRef.current = mr

    // Web Speech API for live preview text
    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (SR) {
      const rec = new SR()
      rec.continuous      = true
      rec.interimResults  = true
      rec.onresult = e => {
        let text = ''
        for (const r of e.results) text += r[0].transcript
        setLiveText(text)
      }
      rec.onerror = () => {}  // non-fatal
      rec.start()
      recRef.current = rec
    }

    setStatus('recording')
  }, [apiKey, mode])

  /* ── Stop recording ── */
  const stopRecording = useCallback(() => {
    recRef.current?.stop()
    recRef.current = null
    mrRef.current?.stop()
    mrRef.current = null
    setStatus('transcribing')
  }, [])

  /* ── Process audio → Groq ── */
  async function processAudio(key) {
    try {
      // 1. Transcribe
      const blob = new Blob(chunksRef.current, {
        type: chunksRef.current[0]?.type ?? 'audio/webm',
      })
      const form = new FormData()
      form.append('file', blob, 'recording.webm')
      form.append('model', STT_MODEL)
      form.append('response_format', 'json')

      const tRes = await fetch(`${GROQ}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      })
      if (!tRes.ok) throw new Error(`Transcription failed (${tRes.status})`)
      const { text } = await tRes.json()
      if (!text?.trim()) throw new Error('No speech detected.')

      const spoken = text.trim()
      setTranscript(spoken)
      setLiveText(spoken)
      setStatus('formatting')

      // 2. Format with LLM (streaming)
      const userContent =
        mode === 'append' && mdRef.current
          ? `Current document:\n${mdRef.current}\n\nNew voice instruction: ${spoken}`
          : spoken

      const fRes = await fetch(`${GROQ}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
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
      if (!fRes.ok) throw new Error(`LLM error (${fRes.status})`)

      const reader = fRes.body.getReader()
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
          } catch { /* skip malformed SSE chunk */ }
        }
      }

      setStatus('done')
    } catch (err) {
      setErrorMsg(err.message)
      setStatus('error')
    }
  }

  /* ── Clear ── */
  const clear = () => {
    setMarkdown('')
    setTranscript('')
    setLiveText('')
    mdRef.current = ''
    setStatus('idle')
    setErrorMsg('')
  }

  /* ── Copy ── */
  const copy = async (what) => {
    const text = what === 'md'
      ? mdRef.current
      : document.getElementById('md-out')?.innerText ?? ''
    await navigator.clipboard.writeText(text)
    setCopied(what)
    setTimeout(() => setCopied(''), 1600)
  }

  /* ── Space shortcut ── */
  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space') return
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return
      e.preventDefault()
      if (isRecording) stopRecording()
      else if (!isBusy) startRecording()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isRecording, isBusy, startRecording, stopRecording])

  /* ── Rendered HTML from markdown ── */
  const htmlOutput = markdown ? marked.parse(markdown) : ''

  return (
    <div className="app">

      {/* ── Header ── */}
      <header className="header">
        <div className="logo">
          <span className="logo-dot" />
          Voice<span className="logo-accent">MD</span>
        </div>

        <div className="header-center">
          <div className="mode-switch">
            {['append', 'replace'].map(m => (
              <button
                key={m}
                className={`mode-btn ${mode === m ? 'active' : ''}`}
                onClick={() => setMode(m)}
              >
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="header-right">
          {markdown && (
            <button className="hdr-btn" onClick={clear}>Clear</button>
          )}
          <button
            className={`hdr-btn ${showKey ? 'hdr-btn--active' : ''}`}
            onClick={() => setShowKey(v => !v)}
          >
            ⚙ API Key
          </button>
        </div>
      </header>

      {/* ── API Key drawer ── */}
      {showKey && (
        <div className="key-drawer">
          <label className="key-label">Groq API Key</label>
          <input
            className="key-input"
            type="password"
            placeholder="gsk_..."
            value={apiKey}
            onChange={e => saveKey(e.target.value)}
            spellCheck={false}
            autoFocus
          />
          <button className="hdr-btn" onClick={() => setShowKey(false)}>Done</button>
        </div>
      )}

      {/* ── Split layout ── */}
      <div className="split">

        {/* Left — Output */}
        <div className="pane pane-left">
          <div className="pane-header">
            <span className="pane-title">Output</span>
            {markdown && (
              <div className="pane-actions">
                <button
                  className={`action-btn ${copied === 'md' ? 'copied' : ''}`}
                  onClick={() => copy('md')}
                >
                  {copied === 'md' ? '✓ Copied' : 'Copy MD'}
                </button>
                <button
                  className={`action-btn ${copied === 'text' ? 'copied' : ''}`}
                  onClick={() => copy('text')}
                >
                  {copied === 'text' ? '✓ Copied' : 'Copy Text'}
                </button>
              </div>
            )}
          </div>

          <div className="pane-body" ref={outputRef}>

            {/* Empty state */}
            {!markdown && !liveText && status === 'idle' && (
              <div className="empty">
                <div className="empty-ring" />
                <p className="empty-title">Start speaking</p>
                <p className="empty-sub">
                  Say <em>"write in points"</em>, <em>"make it a heading"</em>,{' '}
                  <em>"bold that"</em>, <em>"remove the last part"</em>…
                </p>
              </div>
            )}

            {/* Live interim text while recording */}
            {(isRecording || status === 'transcribing') && (
              <div className="live-section">
                <span className="live-pill">● LIVE</span>
                <p className="live-text">
                  {liveText || <span className="muted">Listening…</span>}
                  {isRecording && <span className="cursor" />}
                </p>
              </div>
            )}

            {/* Processing badge */}
            {isBusy && (
              <div className="busy-row">
                <span className="spinner" />
                <span className="busy-label">
                  {status === 'transcribing' ? 'Transcribing…' : 'Formatting…'}
                </span>
              </div>
            )}

            {/* Formatted markdown */}
            {markdown && (
              <div
                id="md-out"
                className={`md-output ${status === 'formatting' ? 'streaming' : ''}`}
                dangerouslySetInnerHTML={{ __html: htmlOutput }}
              />
            )}

            {/* Error */}
            {errorMsg && <div className="error-pill">{errorMsg}</div>}

          </div>
        </div>

        {/* Divider */}
        <div className="divider" />

        {/* Right — Waveform + Record */}
        <div className="pane pane-right">
          <div className="pane-header">
            <span className="pane-title">Voice Input</span>
            <span className={`status-chip status-${status}`}>
              {status === 'idle'         && 'Ready'}
              {status === 'recording'    && '● Recording'}
              {status === 'transcribing' && '◌ Transcribing'}
              {status === 'formatting'   && '◌ Formatting'}
              {status === 'done'         && '✓ Done'}
              {status === 'error'        && '✕ Error'}
            </span>
          </div>

          <div className="wave-area">
            <Waveform analyser={analyser} isRecording={isRecording} />
          </div>

          <div className="record-footer">
            <button
              className={`record-btn ${isRecording ? 'rec' : ''} ${isBusy ? 'busy' : ''}`}
              onClick={isRecording ? stopRecording : startRecording}
              disabled={isBusy}
              aria-label={isRecording ? 'Stop recording' : 'Start recording'}
            >
              {isBusy ? (
                <span className="btn-spinner" />
              ) : isRecording ? (
                /* Stop square */
                <svg viewBox="0 0 24 24" fill="currentColor" className="btn-icon">
                  <rect x="6" y="6" width="12" height="12" rx="2.5" />
                </svg>
              ) : (
                /* Mic */
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round" strokeLinejoin="round" className="btn-icon">
                  <rect x="9" y="2" width="6" height="13" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="19" x2="12" y2="22" />
                  <line x1="8"  y1="22" x2="16" y2="22" />
                </svg>
              )}
            </button>
            <p className="shortcut">
              press <kbd>Space</kbd> or click
            </p>
          </div>
        </div>

      </div>
    </div>
  )
}
