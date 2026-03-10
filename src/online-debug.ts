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
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${msg}`;
  console.log(`[online-debug] ${msg}`);
  if (!debugEnabled) return;
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

// Show overlay immediately so user knows debug mode is active
if (debugEnabled) {
  dlog('debug mode active');
}
