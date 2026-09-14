import { TOKEN_KEY } from './api'

/// Reads a turn's events as they happen. Server-sent events over a fetch
/// — EventSource cannot send the auth header — with the last event id
/// remembered so a dropped connection resumes instead of replaying.
export interface AgentEvent {
  type: string
  [k: string]: unknown
}

export function streamAgentEvents(threadId: string, onEvent: (id: number, e: AgentEvent) => void, onEnd: (reason: 'done' | 'error' | 'idle' | 'closed') => void): () => void {
  const ctrl = new AbortController()
  let lastId = 0
  let closed = false

  const connect = async () => {
    let attempt = 0
    while (!closed) {
      try {
        const res = await fetch(`/api/agent/threads/${threadId}/events?since=${lastId}`, {
          headers: { Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY) ?? ''}` },
          signal: ctrl.signal,
        })
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
        attempt = 0
        const reader = res.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let sep: number
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            let id = 0
            let type = ''
            let data = ''
            for (const line of block.split('\n')) {
              if (line.startsWith('id:')) id = Number(line.slice(3).trim())
              else if (line.startsWith('event:')) type = line.slice(6).trim()
              else if (line.startsWith('data:')) data += line.slice(5).trim()
            }
            if (!type) continue
            if (type === 'idle') {
              closed = true
              onEnd('idle')
              return
            }
            if (id) lastId = id
            let parsed: AgentEvent = { type }
            try {
              parsed = { type, ...(data ? JSON.parse(data) : {}) }
            } catch {
              /* a malformed frame is skipped */
            }
            onEvent(id, parsed)
            if (type === 'done' || type === 'error') {
              closed = true
              onEnd(type)
              return
            }
          }
        }
        // The server closed without a terminal event: reconnect from lastId.
      } catch (err) {
        if (closed || ctrl.signal.aborted) return
        attempt += 1
        if (attempt > 6) {
          closed = true
          onEnd('closed')
          return
        }
        await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt)))
      }
    }
  }
  void connect()
  return () => {
    closed = true
    ctrl.abort()
  }
}
