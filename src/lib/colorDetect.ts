import type { Point } from "./physics";

export type Hsv = { h: number; s: number; v: number };
export type Frame = { data: Uint8ClampedArray; width: number; height: number };

const MIN_BLOB_PIXELS = 12;

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === r) h = ((g - b) / delta + 6) % 6;
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    h *= 60;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max / 255 };
}

export function averageHsv(frame: Frame, center: Point, radius = 3): Hsv {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = Math.round(center.y) - radius; y <= Math.round(center.y) + radius; y++) {
    for (let x = Math.round(center.x) - radius; x <= Math.round(center.x) + radius; x++) {
      if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) continue;
      const i = (y * frame.width + x) * 4;
      r += frame.data[i];
      g += frame.data[i + 1];
      b += frame.data[i + 2];
      count++;
    }
  }
  return rgbToHsv(r / count, g / count, b / count);
}

// Centroide de la mancha de color más grande: los píxeles sueltos del fondo no desplazan la posición.
export function detectColor(frame: Frame, target: Hsv, hueTolerance: number): Point | null {
  const { data, width, height } = frame;
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) {
    const { h, s, v } = rgbToHsv(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    const hueDifference = Math.abs(h - target.h);
    const matches =
      Math.min(hueDifference, 360 - hueDifference) <= hueTolerance &&
      s >= Math.max(0.2, target.s - 0.35) &&
      Math.abs(v - target.v) <= 0.45;
    if (matches) mask[p] = 1;
  }

  const stack = new Int32Array(mask.length);
  let best: { count: number; sumX: number; sumY: number } | null = null;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start]) continue;
    const blob = { count: 0, sumX: 0, sumY: 0 };
    let top = 0;
    stack[top++] = start;
    mask[start] = 0;
    while (top > 0) {
      const p = stack[--top];
      const x = p % width;
      const y = (p - x) / width;
      blob.count++;
      blob.sumX += x;
      blob.sumY += y;
      if (x > 0 && mask[p - 1]) { mask[p - 1] = 0; stack[top++] = p - 1; }
      if (x < width - 1 && mask[p + 1]) { mask[p + 1] = 0; stack[top++] = p + 1; }
      if (y > 0 && mask[p - width]) { mask[p - width] = 0; stack[top++] = p - width; }
      if (y < height - 1 && mask[p + width]) { mask[p + width] = 0; stack[top++] = p + width; }
    }
    if (!best || blob.count > best.count) best = blob;
  }

  if (!best || best.count < MIN_BLOB_PIXELS) return null;
  return { x: best.sumX / best.count, y: best.sumY / best.count };
}
