export function seekTo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve) => {
    if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= 2) {
      resolve();
      return;
    }
    video.addEventListener("seeked", () => resolve(), { once: true });
    video.currentTime = time;
  });
}

// Los clips de MediaRecorder reportan duración Infinity hasta que se busca más allá del final.
export function resolveDuration(video: HTMLVideoElement) {
  return new Promise<number>((resolve) => {
    if (Number.isFinite(video.duration)) {
      resolve(video.duration);
      return;
    }
    const onChange = () => {
      if (!Number.isFinite(video.duration)) return;
      video.removeEventListener("durationchange", onChange);
      resolve(video.duration);
    };
    video.addEventListener("durationchange", onChange);
    video.currentTime = 1e7;
  });
}

export type FrameSample = { t: number; seekTime: number };

// Pedir el instante exacto en que empieza un fotograma puede mostrar el anterior, así que se busca su mitad.
export function frameSeekTime(t: number, fps: number) {
  return t + 0.5 / fps;
}

// Cada muestra es un fotograma completo: su tiempo es el inicio de ese fotograma, sin redondeos intermedios.
export function frameSamples(start: number, end: number, fps: number, samplesPerSecond: number): FrameSample[] {
  const stride = Math.max(1, Math.round(fps / samplesPerSecond));
  const first = Math.ceil(start * fps - 1e-6);
  const last = Math.floor(end * fps + 1e-6);
  const samples: FrameSample[] = [];
  for (let frame = first; frame <= last; frame += stride) {
    samples.push({ t: frame / fps, seekTime: frameSeekTime(frame / fps, fps) });
  }
  return samples;
}
