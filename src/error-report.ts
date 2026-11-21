import { Capacitor } from '@capacitor/core';
import { version } from '../package.json';
import { SUPABASE_URL } from './online';

/** What the browser tells us about one uncaught error. */
export interface ErrorEventInfo {
  message: string;
  filename?: string;
  error?: unknown;
}

/** The whole report: no player ID, name or device details. */
export interface ErrorReport {
  message: string;
  stack: string;
  version: string;
  platform: string;
}

interface ReporterOptions {
  send: (report: ErrorReport) => void;
  origin: string;
  version: string;
  platform: string;
}

/** Most reports one session sends; a loop of errors must not flood the server. */
const MAX_REPORTS = 5;

/** Turn browser error events into reports: each distinct error once, at most
 *  five a session, with the site's address cut from file paths. */
export function createErrorReporter(opts: ReporterOptions): (info: ErrorEventInfo) => void {
  const seen = new Set<string>();
  return info => {
    // "Script error." with no file is a cross-origin script we can't see into.
    if (info.message === 'Script error.' || (info.filename && !info.filename.startsWith(opts.origin))) return;
    const message = info.message.slice(0, 300);
    if (seen.has(message) || seen.size >= MAX_REPORTS) return;
    seen.add(message);
    const rawStack = info.error instanceof Error ? info.error.stack ?? '' : '';
    const stack = rawStack.split(opts.origin).join('').split('\n').slice(0, 8).join('\n').slice(0, 1500);
    opts.send({ message, stack, version: opts.version, platform: opts.platform });
  };
}

/** Send uncaught errors from the released game to the client-error function,
 *  so crashes on players' devices show up in the server logs. */
export function installErrorReporting(): void {
  if (import.meta.env.DEV) return;
  const report = createErrorReporter({
    // text/plain keeps this a simple request (no CORS preflight); keepalive
    // lets it finish if the page is closing.
    send: body => {
      void fetch(`${SUPABASE_URL}/functions/v1/client-error`, {
        method: 'POST', body: JSON.stringify(body), keepalive: true, headers: { 'Content-Type': 'text/plain' },
      }).catch(() => { /* reporting is best effort; never error about errors */ });
    },
    origin: location.origin,
    version,
    platform: Capacitor.getPlatform(),
  });
  window.addEventListener('error', e => report({ message: e.message, filename: e.filename, error: e.error }));
  window.addEventListener('unhandledrejection', e => {
    const reason: unknown = e.reason;
    report({ message: reason instanceof Error ? reason.message : String(reason), error: reason });
  });
}
