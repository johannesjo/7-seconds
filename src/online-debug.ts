/** On-screen debug logger for diagnosing mobile connection issues.
 *  Activated by adding ?debug=1 to the URL. */

const MAX_LINES = 40;
const lines: string[] = [];
let overlay: HTMLPreElement | null = null;

export const debugEnabled = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('debug');

function ensureOverlay(): HTMLPreElement {
  if (overlay) return overlay;
  overlay = document.createElement('pre');
  Object.assign(overlay.style, {
    position: 'fixed',
    bottom: '0',
    left: '0',
    right: '0',
    maxHeight: '45vh',
    overflow: 'auto',
    background: 'rgba(0,0,0,0.85)',
    color: '#0f0',
    fontSize: '11px',
    fontFamily: 'monospace',
    padding: '8px',
    margin: '0',
    zIndex: '9999',
    pointerEvents: 'auto',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  });
  document.body.appendChild(overlay);
  return overlay;
}

/** Log a debug message to the on-screen overlay (only when ?debug=1). */
export function dlog(msg: string): void {
  if (!debugEnabled) return;
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${msg}`;
  console.log(`[online-debug] ${msg}`);
  lines.push(line);
  if (lines.length > MAX_LINES) lines.shift();
  const el = ensureOverlay();
  el.textContent = lines.join('\n');
  el.scrollTop = el.scrollHeight;
}

/** Attach ICE diagnostics to an RTCPeerConnection. */
export function monitorPeerConnection(pc: RTCPeerConnection, label: string): void {
  pc.addEventListener('iceconnectionstatechange', () => {
    dlog(`${label} ice-conn: ${pc.iceConnectionState}`);
  });
  pc.addEventListener('icegatheringstatechange', () => {
    dlog(`${label} ice-gather: ${pc.iceGatheringState}`);
  });
  pc.addEventListener('connectionstatechange', () => {
    dlog(`${label} conn: ${pc.connectionState}`);
  });
  pc.addEventListener('icecandidate', (e) => {
    if (e.candidate) {
      const c = e.candidate;
      dlog(`${label} candidate: ${c.type ?? '?'} ${c.protocol ?? ''} ${c.address ?? '?'}:${c.port ?? '?'}`);
    } else {
      dlog(`${label} ice gathering done (null candidate)`);
    }
  });
  pc.addEventListener('signalingstatechange', () => {
    dlog(`${label} signaling: ${pc.signalingState}`);
  });
}

/** Poll getPeers() and attach monitors to any new peer connections. */
export function startPeerMonitor(getPeers: () => Record<string, RTCPeerConnection>, label: string): () => void {
  const monitored = new Set<string>();
  const interval = setInterval(() => {
    const peers = getPeers();
    for (const [id, pc] of Object.entries(peers)) {
      if (!monitored.has(id)) {
        monitored.add(id);
        dlog(`${label} new peer: ${id.slice(0, 8)}… state=${pc.connectionState}`);
        monitorPeerConnection(pc, `${label}:${id.slice(0, 8)}`);
      }
    }
  }, 500);
  return () => clearInterval(interval);
}

/** Run a Supabase Realtime connectivity test. */
export async function testSupabaseRealtime(appId: string, supabaseKey: string): Promise<void> {
  if (typeof window === 'undefined') return;
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(appId, supabaseKey);
  const testTopic = `_diag_${Date.now()}`;
  const chan = client.channel(testTopic);

  dlog('supabase: testing realtime...');

  const result = await new Promise<string>((resolve) => {
    const timeout = setTimeout(() => resolve('timeout (10s)'), 10_000);
    chan.subscribe((status) => {
      dlog(`supabase: channel status = ${status}`);
      if (status === 'SUBSCRIBED') {
        clearTimeout(timeout);
        resolve('ok');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        clearTimeout(timeout);
        resolve(`failed: ${status}`);
      }
    });
  });

  dlog(`supabase: realtime test = ${result}`);
  client.removeChannel(chan);
  client.removeAllChannels();
}

/** Parse a Phoenix/Supabase WS message and return a loggable summary. */
function parseWsMsg(data: string): string | null {
  try {
    const parsed = JSON.parse(data);
    // Phoenix messages are arrays: [joinRef, ref, topic, event, payload]
    if (Array.isArray(parsed) && parsed.length >= 4 && typeof parsed[3] === 'string') {
      const event = parsed[3];
      const topic = parsed[2];
      if (event !== 'heartbeat') {
        return `${event} topic=${String(topic).slice(0, 30)}`;
      }
      return null;
    }
    // Object-style message
    if (parsed && typeof parsed === 'object' && parsed.event) {
      if (parsed.event !== 'heartbeat') {
        return `${parsed.event} topic=${String(parsed.topic ?? '').slice(0, 30)}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Parse a Supabase v2 binary broadcast message. */
function parseBinaryBroadcast(buf: ArrayBuffer): string {
  try {
    const view = new DataView(buf);
    const kind = view.getUint8(0);
    // kind 3 = userBroadcastPush (outgoing), kind 4 = userBroadcast (incoming)
    if (kind !== 3 && kind !== 4) return `kind=${kind} len=${buf.byteLength}`;
    const decoder = new TextDecoder();
    if (kind === 3) {
      // [kind, joinRefLen, refLen, topicLen, eventLen, metaLen, encoding, ...data]
      const topicLen = view.getUint8(3);
      const eventLen = view.getUint8(4);
      let offset = 7;
      const joinRefLen = view.getUint8(1);
      const refLen = view.getUint8(2);
      offset += joinRefLen + refLen;
      const topic = decoder.decode(buf.slice(offset, offset + topicLen));
      offset += topicLen;
      const event = decoder.decode(buf.slice(offset, offset + eventLen));
      return `event=${event} topic=${topic.slice(0, 30)} (${buf.byteLength}B)`;
    }
    // kind 4: [kind, topicLen, eventLen, metaLen, encoding, ...data]
    const topicLen = view.getUint8(1);
    const eventLen = view.getUint8(2);
    const offset = 5;
    const topic = decoder.decode(buf.slice(offset, offset + topicLen));
    const event = decoder.decode(buf.slice(offset + topicLen, offset + topicLen + eventLen));
    return `event=${event} topic=${topic.slice(0, 30)} (${buf.byteLength}B)`;
  } catch {
    return `binary len=${buf.byteLength}`;
  }
}

/** Patch RTCPeerConnection to log ALL connection state changes and ICE candidates. */
function interceptRTC(): void {
  if (typeof window === 'undefined') return;
  const OrigRTC = window.RTCPeerConnection;
  let pcCount = 0;
  const pcIds = new WeakMap<RTCPeerConnection, number>();

  // Patch prototype.setRemoteDescription to catch ALL calls reliably
  const origSetRemote = OrigRTC.prototype.setRemoteDescription;
  OrigRTC.prototype.setRemoteDescription = function (
    this: RTCPeerConnection,
    desc: RTCSessionDescriptionInit,
  ) {
    const id = pcIds.get(this) ?? '?';
    const sdp = desc.sdp ?? '';
    const host = (sdp.match(/typ host/g) || []).length;
    const srflx = (sdp.match(/typ srflx/g) || []).length;
    const relay = (sdp.match(/typ relay/g) || []).length;
    dlog(`rtc#${id} setRemote(${desc.type}) host=${host} srflx=${srflx} relay=${relay}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (origSetRemote as any).call(this, desc);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).RTCPeerConnection = function (config?: RTCConfiguration) {
    const id = pcCount++;
    const pc = new OrigRTC(config);
    pcIds.set(pc, id);
    if (id < 3) {
      dlog(`rtc#${id} created servers=${config?.iceServers?.length ?? 0}`);
    }
    pc.addEventListener('connectionstatechange', () => {
      dlog(`rtc#${id} conn: ${pc.connectionState}`);
    });
    pc.addEventListener('iceconnectionstatechange', () => {
      dlog(`rtc#${id} ice: ${pc.iceConnectionState}`);
    });
    pc.addEventListener('icegatheringstatechange', () => {
      const sdp = pc.localDescription?.sdp ?? '';
      const host = (sdp.match(/typ host/g) || []).length;
      const srflx = (sdp.match(/typ srflx/g) || []).length;
      const relay = (sdp.match(/typ relay/g) || []).length;
      dlog(`rtc#${id} gather=${pc.iceGatheringState} host=${host} srflx=${srflx} relay=${relay}`);
    });
    return pc;
  } as unknown as typeof RTCPeerConnection;
  (window as any).RTCPeerConnection.prototype = OrigRTC.prototype;
}

/** Intercept WebSocket to log Supabase Realtime connection lifecycle. */
function interceptWebSocket(): void {
  if (typeof window === 'undefined') return;

  // Patch WebSocket.prototype.send to log ALL outgoing messages
  const origSend = WebSocket.prototype.send;
  let sendCount = 0;
  WebSocket.prototype.send = function (this: WebSocket, data) {
    if (!this.url?.includes('supabase')) return origSend.call(this, data);

    if (typeof data === 'string') {
      if (sendCount < 5) {
        dlog(`ws→raw[${sendCount}] ${data.slice(0, 200)}`);
        sendCount++;
      }
      const summary = parseWsMsg(data);
      if (summary) dlog(`ws→ ${summary}`);
    } else {
      // Supabase v2 encodes broadcasts as binary (ArrayBuffer/TypedArray)
      try {
        let buf: ArrayBuffer;
        if (data instanceof ArrayBuffer) buf = data;
        else if (ArrayBuffer.isView(data)) buf = data.buffer as ArrayBuffer;
        else { dlog(`ws→ non-string type=${typeof data} ctor=${data?.constructor?.name}`); return origSend.call(this, data); }
        const summary = parseBinaryBroadcast(buf);
        dlog(`ws→bin ${summary}`);
      } catch (e) {
        dlog(`ws→bin parse-err: ${e}`);
      }
    }
    return origSend.call(this, data);
  };

  // Patch WebSocket constructor to log connections and incoming messages
  const OrigWS = window.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).WebSocket = function (url: string | URL, protocols?: string | string[]) {
    const ws = new OrigWS(url, protocols);
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('supabase') || urlStr.includes('realtime')) {
      dlog(`ws open: ${urlStr.slice(0, 80)}…`);
      ws.addEventListener('open', () => dlog('ws connected'));
      ws.addEventListener('close', (e) => dlog(`ws closed code=${e.code} reason=${e.reason}`));
      ws.addEventListener('error', () => dlog('ws error'));
      let recvCount = 0;
      ws.addEventListener('message', (e) => {
        if (typeof e.data === 'string') {
          if (recvCount < 5) {
            dlog(`ws←raw[${recvCount}] ${e.data.slice(0, 200)}`);
            recvCount++;
          }
          const summary = parseWsMsg(e.data);
          if (summary) dlog(`ws← ${summary}`);
        } else if (e.data instanceof ArrayBuffer) {
          const summary = parseBinaryBroadcast(e.data);
          dlog(`ws←bin ${summary}`);
        } else if (e.data instanceof Blob) {
          e.data.arrayBuffer().then((buf) => {
            const summary = parseBinaryBroadcast(buf);
            dlog(`ws←bin ${summary}`);
          });
        }
      });
    }
    return ws;
  } as unknown as typeof WebSocket;
  (window as any).WebSocket.prototype = OrigWS.prototype;
  (window as any).WebSocket.CONNECTING = OrigWS.CONNECTING;
  (window as any).WebSocket.OPEN = OrigWS.OPEN;
  (window as any).WebSocket.CLOSING = OrigWS.CLOSING;
  (window as any).WebSocket.CLOSED = OrigWS.CLOSED;
}

/** Run environment capability tests to diagnose mobile failures. */
async function runDiagnostics(): Promise<void> {
  // Test 1: Secure context (crypto.subtle requires HTTPS or localhost)
  const isSecure = window.isSecureContext;
  dlog(`secure-context: ${isSecure}`);
  dlog(`crypto.subtle: ${crypto.subtle ? 'available' : 'MISSING'}`);

  if (!crypto.subtle) {
    dlog('FATAL: crypto.subtle unavailable — need HTTPS!');
    return;
  }

  // Test 2: SHA-1 digest
  try {
    const encoder = new TextEncoder();
    const t0 = performance.now();
    await crypto.subtle.digest('SHA-1', encoder.encode('test'));
    dlog(`sha1: ok (${(performance.now() - t0).toFixed(0)}ms)`);
  } catch (e) {
    dlog(`sha1: FAILED — ${e}`);
  }

  // Test 3: RTCPeerConnection creation
  try {
    const pc = new RTCPeerConnection();
    dlog(`rtc: ok state=${pc.connectionState}`);
    pc.close();
  } catch (e) {
    dlog(`rtc: FAILED — ${e}`);
  }

  // Test 4: location protocol
  dlog(`proto: ${location.protocol} host: ${location.hostname}`);
}

// Show overlay immediately so user knows debug mode is active
if (debugEnabled) {
  // Catch silent promise rejections (e.g. crypto.subtle failures)
  window.addEventListener('unhandledrejection', (e) => {
    dlog(`UNHANDLED REJECT: ${e.reason}`);
  });
  window.addEventListener('error', (e) => {
    dlog(`ERROR: ${e.message}`);
  });
  interceptRTC();
  interceptWebSocket();
  dlog('debug mode active');
  runDiagnostics();
}
