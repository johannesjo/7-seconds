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

  const stop = (): Promise<void> => new Promise<void>(resolve => {
    clearTimeout(limitTimer);
    if (recorder.state === 'inactive') { resolve(); return; }
    recorder.onstop = () => resolve();
    recorder.stop();
  }).then(() => {
    // Only the canvas track: the audio track belongs to the shared game mix.
    for (const track of stream.getVideoTracks()) track.stop();
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

function clipFile(blob: Blob): File {
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  return new File([blob], `7-seconds-battle.${ext}`, { type: blob.type });
}

/** Whether the share sheet accepts the clip. Sharing needs a fresh tap, so
 *  callers must call shareClip from a click handler, not after an await. */
export function canShareClip(blob: Blob): boolean {
  return navigator.canShare?.({ files: [clipFile(blob)] }) ?? false;
}

/** Open the share sheet; falls back to a download if sharing fails. */
export async function shareClip(blob: Blob): Promise<'shared' | 'downloaded' | 'cancelled'> {
  try {
    await navigator.share({ files: [clipFile(blob)], title: '7 Seconds battle' });
    return 'shared';
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') return 'cancelled';
    downloadClip(blob);
    return 'downloaded';
  }
}

export function downloadClip(blob: Blob): void {
  const file = clipFile(blob);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
