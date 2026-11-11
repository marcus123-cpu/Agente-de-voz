import { useCallback, useEffect, useRef, useState } from 'react'
import { Headphones, Square } from 'lucide-react'
import { apiBase } from './api'

type Line = { id: number; role: 'patient' | 'agent'; text: string }
type Phase = 'idle' | 'connecting' | 'on'

const SAMPLE_RATE = 16000
const MAX_LINES = 60

function listenUrl(callId: string) {
  const base = apiBase || window.location.origin
  return `${base.replace(/^http/, 'ws')}/ws/calls/${callId}/listen`
}

/**
 * Escuta ao vivo da ligação dentro do painel. O áudio vem do servidor em PCM16
 * 16 kHz (1 byte de origem + amostras) e é tocado só aqui; nada é gravado.
 */
export function LiveListen({ callId, active, humanTakeover, compact = false }: { callId: string; active: boolean; humanTakeover: boolean; compact?: boolean }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [volume, setVolume] = useState(1)
  const [levels, setLevels] = useState({ patient: 0, agent: 0 })
  const [lines, setLines] = useState<Line[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const nextRef = useRef<{ patient: number; agent: number }>({ patient: 0, agent: 0 })
  const agentNodes = useRef<Set<AudioBufferSourceNode>>(new Set())
  const levelRef = useRef({ patient: 0, agent: 0 })
  const lineId = useRef(0)
  const transcriptRef = useRef<HTMLDivElement | null>(null)

  const stop = useCallback(() => {
    const ws = wsRef.current
    wsRef.current = null
    if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close() } catch { /* já fechado */ } }
    for (const node of agentNodes.current) { try { node.stop() } catch { /* já terminou */ } }
    agentNodes.current.clear()
    const ctx = ctxRef.current
    ctxRef.current = null
    gainRef.current = null
    if (ctx) void ctx.close().catch(() => undefined)
    levelRef.current = { patient: 0, agent: 0 }
    setLevels({ patient: 0, agent: 0 })
    setPhase('idle')
  }, [])

  const playChunk = useCallback((source: 'patient' | 'agent', buffer: ArrayBuffer) => {
    const ctx = ctxRef.current
    const gain = gainRef.current
    if (!ctx || !gain || buffer.byteLength < 4) return
    const pcm = new Int16Array(buffer.slice(1, 1 + ((buffer.byteLength - 1) & ~1)))
    const audio = ctx.createBuffer(1, pcm.length, SAMPLE_RATE)
    const data = audio.getChannelData(0)
    let sum = 0
    for (let i = 0; i < pcm.length; i++) { const v = pcm[i]! / 32768; data[i] = v; sum += v * v }
    levelRef.current[source] = Math.min(1, Math.sqrt(sum / pcm.length) * 4)
    const node = ctx.createBufferSource()
    node.buffer = audio
    node.connect(gain)
    // A Giovana chega mais rápido que tempo real: enfileira para tocar em sequência.
    const start = Math.max(nextRef.current[source], ctx.currentTime + 0.12)
    node.start(start)
    nextRef.current[source] = start + audio.duration
    if (source === 'agent') { agentNodes.current.add(node); node.onended = () => agentNodes.current.delete(node) }
  }, [])

  const start = useCallback(async () => {
    setError('')
    setPhase('connecting')
    try {
      const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
      await ctx.resume()
      const gain = ctx.createGain()
      gain.gain.value = volume
      gain.connect(ctx.destination)
      ctxRef.current = ctx
      gainRef.current = gain
      nextRef.current = { patient: 0, agent: 0 }
      const ws = new WebSocket(listenUrl(callId))
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      ws.onopen = () => setPhase('on')
      ws.onerror = () => setError('Não foi possível conectar a escuta. Verifique se a ligação está ativa.')
      ws.onclose = () => stop()
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const tag = new Uint8Array(event.data, 0, 1)[0]
          playChunk(tag === 1 ? 'patient' : 'agent', event.data)
          return
        }
        let message: { type?: string; role?: 'patient' | 'agent'; text?: string; correction?: boolean }
        try { message = JSON.parse(String(event.data)) } catch { return }
        if (message.type === 'flush') {
          for (const node of agentNodes.current) { try { node.stop() } catch { /* já terminou */ } }
          agentNodes.current.clear()
          nextRef.current.agent = 0
        }
        if (message.type === 'text' && message.role && message.text) {
          const { role, text, correction } = message
          setLines((old) => {
            if (correction) {
              const index = [...old].reverse().findIndex((line) => line.role === 'agent')
              if (index >= 0) { const at = old.length - 1 - index; const copy = old.slice(); copy[at] = { ...old[at]!, text }; return copy }
            }
            return [...old, { id: ++lineId.current, role, text }].slice(-MAX_LINES)
          })
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Não foi possível iniciar a escuta.')
      stop()
    }
  }, [callId, playChunk, stop, volume])

  useEffect(() => { if (gainRef.current) gainRef.current.gain.value = volume }, [volume])
  useEffect(() => () => stop(), [stop])
  useEffect(() => { if (!active) stop() }, [active, stop])
  useEffect(() => { setLines([]); lineId.current = 0 }, [callId])
  useEffect(() => { transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight }) }, [lines])
  useEffect(() => {
    if (phase !== 'on') return
    const timer = window.setInterval(() => {
      setLevels({ ...levelRef.current })
      levelRef.current = { patient: levelRef.current.patient * 0.6, agent: levelRef.current.agent * 0.6 }
    }, 120)
    return () => window.clearInterval(timer)
  }, [phase])

  const listening = phase === 'on'
  // Widget compacto: a escuta começa sozinha com a ligação (a saída de som é só a do painel, desde o toque).
  // Se o operador parar de ouvir, não religa sozinha naquela ligação.
  const autoStarted = useRef<string | null>(null)
  useEffect(() => {
    if (!compact || !active || humanTakeover || autoStarted.current === callId) return
    autoStarted.current = callId
    void start()
  }, [compact, active, humanTakeover, callId, start])
  // Atalho Numpad 1 (só no widget compacto): liga/desliga a escuta, fora de campos de texto.
  const toggleRef = useRef<() => void>(() => {})
  toggleRef.current = () => { if (listening || phase === 'connecting') stop(); else if (active && !humanTakeover) void start() }
  useEffect(() => {
    if (!compact) return
    function onKey(event: KeyboardEvent) {
      if (event.code !== 'Numpad1' || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
      event.preventDefault()
      toggleRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [compact])
  if (compact) {
    return <>
      {listening || phase === 'connecting'
        ? <button className="cw-act cw-act-on" onClick={stop}><Square size={13}/>Parar de ouvir [1]</button>
        : <button className="cw-act" disabled={!active || humanTakeover} title={humanTakeover ? 'Você assumiu: o áudio passa pelo webphone' : undefined} onClick={() => void start()}><Headphones size={13}/>Ouvir [1]</button>}
      {error && <small className="cw-err">{error}</small>}
    </>
  }
  return (
    <div className="supervisor-panel">
      <div className="panel-head">
        <div><span className="eyebrow">ESCUTA AO VIVO</span><h3>Ouça a conversa da Giovana com o paciente</h3></div>
        <span className={listening ? 'small-pill green' : 'small-pill'}>{listening ? 'Ouvindo' : phase === 'connecting' ? 'Conectando' : 'Desligada'}</span>
      </div>
      <div className="monitor-controls">
        {listening || phase === 'connecting'
          ? <button className="monitor-button monitor-button-active" onClick={stop}><Square size={14} />Parar de ouvir</button>
          : <button className="monitor-button" disabled={!active} onClick={() => void start()}><Headphones size={15} />Ouvir ao vivo</button>}
        <label className="volume">Volume<input type="range" min="0" max="1.5" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label>
      </div>
      {listening && <div className="meters">
        <div className="level-row"><span>Paciente</span><div className="level-track"><div style={{ width: `${Math.round(levels.patient * 100)}%` }} /></div></div>
        <div className="level-row"><span>Giovana</span><div className="level-track"><div style={{ width: `${Math.round(levels.agent * 100)}%` }} /></div></div>
      </div>}
      {error && <p className="error-text">{error}</p>}
      {humanTakeover
        ? <p className="muted">Você assumiu a ligação: o áudio da conversa agora passa pelo webphone cVortex, não mais pelo painel. Fale e ouça por ele.</p>
        : <p className="muted">Use fones de ouvido para não gerar eco. O áudio só passa por aqui e não é gravado.</p>}
      {lines.length > 0 && <div className="live-transcript" ref={transcriptRef}>
        {lines.map((line) => <p key={line.id} className={`live-line live-${line.role}`}><strong>{line.role === 'agent' ? 'Giovana' : 'Paciente'}</strong>{line.text}</p>)}
      </div>}
    </div>
  )
}
