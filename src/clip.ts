/** Record the battle canvas (plus game audio) to a short video for sharing. */
import { Capacitor } from '@capacitor/core';

const FPS = 30;
const MAX_MS = 30_000;
const MIME_TYPES = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];

/** The Android WebView can neither share nor download a blob, so clips are web-only. */
export function canRecordClips(): boolean {
  return !Capacitor.isNativePlatform()
    && typeof MediaRecorder !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && MIME_TYPES.some(m => MediaRecorder.isTypeSupported(m));
}

export interface ClipRecording {
  /** Finish and return the video (null if nothing was captured). */
  finish(): Promise<Blob | null>;
  /** Stop and throw the recording away. */
  cancel(): void;
}

/** Start recording; `onLimit` fires if the clip hits the length cap first. */
export function startClipRecording(
  canvas: HTMLCanvasElement,
  audioStream: MediaStream | null,
  onLimit: () => void,
): ClipRecording | null {
  const mimeType = MIME_TYPES.find(m => MediaRecorder.isTypeSupported(m));
  if (!mimeType) return null;
  let stream: MediaStream;
  try {
    stream = canvas.captureStream(FPS);
    for (const track of audioStream?.getAudioTracks() ?? []) stream.addTrack(track);
  } catch {
    return null;
  }
  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: Blob[] = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.start(250);
  const limitTimer = setTimeout(onLimit, MAX_MS);

  const stop = (): Promise<void> => new Promise(resolve => {
    clearTimeout(limitTimer);
    if (recorder.state === 'inactive') { resolve(); return; }
    recorder.onstop = () => resolve();
    recorder.stop();
  });

  return {
    async finish() {
      await stop();
      return chunks.length > 0 ? new Blob(chunks, { type: mimeType.split(';')[0] }) : null;
    },
    cancel() {
      void stop();
      chunks.length = 0;
    },
  };
}

/** Hand the clip to the share sheet when the browser can share files,
 *  otherwise download it. Returns how it was delivered. */
export async function deliverClip(blob: Blob): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const file = new File([blob], `7-seconds-battle.${ext}`, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '7 Seconds battle' });
      return 'shared';
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return 'cancelled';
      // Fall through to a download when sharing fails for other reasons.
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'downloaded';
}
