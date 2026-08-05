/**
 * Canvas Agent (M3-T2, impl spec §5.4) — client-side video filmstrip extraction.
 *
 * Key insight from the spec: since video already streams via Range (M2-T4, done),
 * thumbnail frames can be extracted entirely in the browser — hidden <video> seek +
 * canvas.drawImage — no server-side ffmpeg extraction, no cache management. Same-origin
 * (the asset route), so no CORS issue with drawImage's canvas taint check.
 */

import { useEffect, useState } from 'react';

export interface FilmstripState {
  frames: string[]; // data URLs, in playback order
  duration: number; // seconds
  loading: boolean;
  error: string | null;
}

function once<K extends keyof HTMLVideoElementEventMap>(
  el: HTMLVideoElement,
  event: K
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`video ${event} failed`));
    };
    const cleanup = () => {
      el.removeEventListener(event, onEvent);
      el.removeEventListener('error', onError);
    };
    el.addEventListener(event, onEvent, { once: true });
    el.addEventListener('error', onError, { once: true });
  });
}

const FRAME_WIDTH = 96;
const FRAME_COUNT = 10;

async function extractFilmstrip(src: string, count: number): Promise<{ frames: string[]; duration: number }> {
  const video = document.createElement('video');
  video.src = src;
  video.muted = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous'; // same-origin in practice; harmless if ignored

  await once(video, 'loadedmetadata');
  const duration = video.duration;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('video has no readable duration');
  }

  const canvas = document.createElement('canvas');
  canvas.width = FRAME_WIDTH;
  canvas.height = Math.max(1, Math.round((FRAME_WIDTH * video.videoHeight) / (video.videoWidth || 1)));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');

  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    // *0.999 keeps the last seek strictly inside the duration (some codecs choke
    // seeking to the exact end timestamp).
    video.currentTime = ((duration * i) / (count - 1)) * 0.999;
    await once(video, 'seeked');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    frames.push(canvas.toDataURL('image/jpeg', 0.6));
  }
  return { frames, duration };
}

/** Extracts a filmstrip for `src` (the canvas video asset URL) once on mount / when
 * src changes. Re-extraction is intentionally NOT debounced/cached across unmounts —
 * trim-panel.tsx only mounts this while the panel is open, so it's a one-shot cost. */
export function useFilmstrip(src: string | null): FilmstripState {
  const [state, setState] = useState<FilmstripState>({ frames: [], duration: 0, loading: false, error: null });

  useEffect(() => {
    if (!src) {
      setState({ frames: [], duration: 0, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ frames: [], duration: 0, loading: true, error: null });
    extractFilmstrip(src, FRAME_COUNT)
      .then(({ frames, duration }) => {
        if (!cancelled) setState({ frames, duration, loading: false, error: null });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ frames: [], duration: 0, loading: false, error: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return state;
}
