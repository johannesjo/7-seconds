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

/** Everyday noise, not bugs: offline requests (Chrome, Safari, Firefox
 *  wording) and a harmless layout warning. Reporting them would use up the
 *  five reports before a real crash. */
const NOISE = /^(Uncaught )?(TypeError: )?((Failed to fetch|Load failed)$|NetworkError when|ResizeObserver loop)/;
/** Cancelled requests and sound blocked until the first tap. */
const NOISE_NAMES = new Set(['AbortError', 'NotAllowedError']);

/** Addresses can carry match ids or tokens. */
const blankUrls = (text: string) => text.replace(/https?:\/\/\S+/g, '<url>');

function isNoise(message: string, name: string): boolean {
  return !message || NOISE.test(message) || NOISE_NAMES.has(name);
}

/** Turn browser error events into reports: each distinct error once, at most
 *  five a session, with the site's address cut from file paths. */
export function createErrorReporter(opts: ReporterOptions): (info: ErrorEventInfo) => void {
  const seen = new Set<string>();
  return info => {
    // "Script error." with no file is a cross-origin script we can't see into.
    if (info.message === 'Script error.' || (info.filename && !info.filename.startsWith(opts.origin))) return;
    const name = info.error instanceof Error || info.error instanceof DOMException ? info.error.name : '';
    // An error thrown without text is still a crash: name it by its type.
    const text = info.message || name;
    if (isNoise(text, name)) return;
    const message = blankUrls(text).slice(0, 300);
    if (seen.has(message) || seen.size >= MAX_REPORTS) return;
    seen.add(message);
    const rawStack = info.error instanceof Error ? info.error.stack ?? '' : '';
    // The game's own files keep their path; any other address is blanked (V8
    // repeats the message on the first line).
    const stack = blankUrls(rawStack.split(opts.origin).join('')).split('\n').slice(0, 8).join('\n').slice(0, 1500);
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
    report({ message: rejectionMessage(e.reason), error: e.reason });
  });
}

/** A rejection's text; '' (not reported) for values without one, which
 *  would all read "[object Object]". */
function rejectionMessage(reason: unknown): string {
  if (typeof reason === 'string') return reason;
  const message: unknown = (reason as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : '';
}
