import { useCallback, useEffect, useRef, useState } from 'react'
import { Headphones, Square } from 'lucide-react'
import { apiBase } from './api'

type Line = { id: number; role: 'patient' | 'agent'; text: string }
type Phase = 'idle' | 'connecting' | 'on'
type ScheduledEntry = { node: AudioBufferSourceNode; nodeGain: GainNode; source: 'patient' | 'agent' }

const SAMPLE_RATE = 16000
const MAX_LINES = 60
// Fade rápido usado para encerrar nodes de forma suave (underrun, flush, stop manual) em vez de um
// node.stop() seco, que causa estalo audível quando a amplitude não está perto de zero.
const FAST_FADE_SECONDS = 0.015

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
  const scheduledNodes = useRef<Set<ScheduledEntry>>(new Set())
  const levelRef = useRef({ patient: 0, agent: 0 })
  const lineId = useRef(0)
  const transcriptRef = useRef<HTMLDivElement | null>(null)
  // Distingue fechamento manual (usuário clicou "Parar de ouvir" / trocou de ligação) de fechamento
  // inesperado do WebSocket, pra só reconectar automaticamente neste último caso.
  const manualStopRef = useRef(false)
  const retryTimerRef = useRef<number | null>(null)
  const activeRef = useRef(active)
  useEffect(() => { activeRef.current = active }, [active])

  // Limpeza pura: fecha ws/ctx, para nodes agendados (com fade rápido pra não estalar) e zera refs.
  // Não decide se foi parada manual ou não — isso é responsabilidade de quem chama.
  const cleanup = useCallback(() => {
    const ws = wsRef.current
    wsRef.current = null
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.onerror = null; try { ws.close() } catch { /* já fechado */ } }
    const ctx = ctxRef.current
    const entries = [...scheduledNodes.current]
    scheduledNodes.current.clear()
    for (const entry of entries) {
      try {
        if (ctx) {
          entry.nodeGain.gain.cancelScheduledValues(ctx.currentTime)
          entry.nodeGain.gain.setValueAtTime(entry.nodeGain.gain.value, ctx.currentTime)
          entry.nodeGain.gain.linearRampToValueAtTime(0, ctx.currentTime + FAST_FADE_SECONDS)
          entry.node.stop(ctx.currentTime + FAST_FADE_SECONDS + 0.005)
        } else {
          entry.node.stop()
        }
      } catch { /* já terminou */ }
    }
    ctxRef.current = null
    gainRef.current = null
    // O fade leva ~20ms: adia o close físico do contexto pra não cortar o fade na mesma tick. Os refs já
    // foram zerados acima, então uma chamada concorrente de cleanup() não tenta fechar o mesmo ctx de novo.
    if (ctx) setTimeout(() => { try { void ctx.close().catch(() => undefined) } catch { /* já fechado por outra chamada */ } }, 30)
    levelRef.current = { patient: 0, agent: 0 }
    setLevels({ patient: 0, agent: 0 })
    setPhase('idle')
  }, [])

  const stop = useCallback(() => {
    manualStopRef.current = true
    if (retryTimerRef.current !== null) { window.clearTimeout(retryTimerRef.current); retryTimerRef.current = null }
    cleanup()
  }, [cleanup])

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
    const nodeGain = ctx.createGain()
    node.connect(nodeGain)
    nodeGain.connect(gain)
    // A Giovana chega mais rápido que tempo real: enfileira para tocar em sequência.
    const start = Math.max(nextRef.current[source], ctx.currentTime + 0.12)
    // Fade-in/out curto (~3ms, nunca mais que meio buffer) pra disfarçar bordas de underrun/flush/stop.
    const fade = Math.min(0.003, audio.duration / 2)
    nodeGain.gain.setValueAtTime(0, start)
    nodeGain.gain.linearRampToValueAtTime(1, start + fade)
    nodeGain.gain.setValueAtTime(1, Math.max(start + fade, start + audio.duration - fade))
    nodeGain.gain.linearRampToValueAtTime(0, start + audio.duration)
    node.start(start)
    nextRef.current[source] = start + audio.duration
    const entry: ScheduledEntry = { node, nodeGain, source }
    scheduledNodes.current.add(entry)
    node.onended = () => scheduledNodes.current.delete(entry)
  }, [])

  const start = useCallback(async () => {
    // Fecha qualquer sessão anterior antes de abrir uma nova (ex.: callId mudou com o componente ainda
    // montado): sem isso o WS/AudioContext antigo continua ativo escrevendo nos refs da sessão nova,
    // misturando áudio de ligações diferentes.
    if (wsRef.current || ctxRef.current) cleanup()
    manualStopRef.current = false
    if (retryTimerRef.current !== null) { window.clearTimeout(retryTimerRef.current); retryTimerRef.current = null }
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
      ws.onclose = (event) => {
        cleanup()
        // code 1000 = fechamento normal (ex.: o servidor encerra a escuta de propósito quando a
        // ligação termina, monitor.ts). Só tenta reconectar em queda inesperada (rede, servidor caiu).
        if (!manualStopRef.current && activeRef.current && event.code !== 1000) {
          setError('Conexão de escuta caiu — reconectando...')
          retryTimerRef.current = window.setTimeout(() => {
            retryTimerRef.current = null
            if (activeRef.current) void start()
          }, 1000)
        }
      }
      ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          const tag = new Uint8Array(event.data, 0, 1)[0]
          if (tag !== 1 && tag !== 2) return
          playChunk(tag === 1 ? 'patient' : 'agent', event.data)
          return
        }
        let message: { type?: string; role?: 'patient' | 'agent'; text?: string; correction?: boolean }
        try { message = JSON.parse(String(event.data)) } catch { return }
        if (message.type === 'flush') {
          const ctxNow = ctxRef.current
          const toStop = [...scheduledNodes.current].filter((entry) => entry.source === 'agent')
          for (const entry of toStop) {
            try {
              if (ctxNow) {
                entry.nodeGain.gain.cancelScheduledValues(ctxNow.currentTime)
                entry.nodeGain.gain.setValueAtTime(entry.nodeGain.gain.value, ctxNow.currentTime)
                entry.nodeGain.gain.linearRampToValueAtTime(0, ctxNow.currentTime + FAST_FADE_SECONDS)
                entry.node.stop(ctxNow.currentTime + FAST_FADE_SECONDS + 0.005)
              } else {
                entry.node.stop()
              }
            } catch { /* já terminou */ }
            scheduledNodes.current.delete(entry)
          }
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
  }, [callId, cleanup, playChunk, stop, volume])

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
