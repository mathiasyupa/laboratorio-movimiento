import { rgbToHsv, type Frame, type Hsv } from "./colorDetect";
import type { Point } from "./physics";

// La IA ubica la regla con varios píxeles de error; aquí se ajusta su línea central y sus extremos sobre la imagen.
const NORMAL_REACH_PX = 40;
const CROSS_SECTIONS = 15;
const MIN_WIDTH_PX = 4;
const MAX_GAP_PX = 8;
const OUTLIER_PX = 2.5;

function colorAt(frame: Frame, p: Point): Hsv | null {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x < 0 || y < 0 || x >= frame.width || y >= frame.height) return null;
  const i = (y * frame.width + x) * 4;
  return rgbToHsv(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
}

function similar(c: Hsv, ref: Hsv) {
  if (Math.abs(c.v - ref.v) > 0.25 || Math.abs(c.s - ref.s) > 0.25) return false;
  // En colores grises el tono no significa nada.
  if (ref.s < 0.2) return true;
  const dh = Math.abs(c.h - ref.h);
  return Math.min(dh, 360 - dh) <= 20;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

// Color típico a lo largo de la línea aproximada: las marcas y números oscuros son minoría y no lo mueven.
function rulerColor(frame: Frame, a: Point, b: Point): Hsv | null {
  const samples: Hsv[] = [];
  for (let i = 1; i < 40; i++) {
    const c = colorAt(frame, { x: a.x + ((b.x - a.x) * i) / 40, y: a.y + ((b.y - a.y) * i) / 40 });
    if (c) samples.push(c);
  }
  if (samples.length < 10) return null;
  const s = median(samples.map((c) => c.s));
  const v = median(samples.map((c) => c.v));
  const colored = samples.filter((c) => c.s >= 0.2);
  const h = colored.length > 0
    ? ((Math.atan2(
        colored.reduce((sum, c) => sum + Math.sin((c.h * Math.PI) / 180), 0),
        colored.reduce((sum, c) => sum + Math.cos((c.h * Math.PI) / 180), 0),
      ) * 180) / Math.PI + 360) % 360
    : 0;
  return { h, s, v };
}

// Centro del tramo de color de la regla que corta la normal, el más cercano a la línea aproximada.
function crossSectionCenter(frame: Frame, base: Point, normal: Point, ref: Hsv): Point | null {
  const runs: { from: number; to: number }[] = [];
  for (let offset = -NORMAL_REACH_PX; offset <= NORMAL_REACH_PX; offset++) {
    const c = colorAt(frame, { x: base.x + normal.x * offset, y: base.y + normal.y * offset });
    if (!c || !similar(c, ref)) continue;
    const last = runs[runs.length - 1];
    if (last && offset - last.to <= 2) last.to = offset;
    else runs.push({ from: offset, to: offset });
  }
  const valid = runs.filter((run) => run.to - run.from + 1 >= MIN_WIDTH_PX);
  if (valid.length === 0) return null;
  const best = valid.reduce((a, b) => (Math.abs((a.from + a.to) / 2) <= Math.abs((b.from + b.to) / 2) ? a : b));
  const center = (best.from + best.to) / 2;
  return { x: base.x + normal.x * center, y: base.y + normal.y * center };
}

function fitLine(points: Point[]) {
  const mean = {
    x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
    y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
  };
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    sxx += (p.x - mean.x) ** 2;
    sxy += (p.x - mean.x) * (p.y - mean.y);
    syy += (p.y - mean.y) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { mean, dir: { x: Math.cos(angle), y: Math.sin(angle) } };
}

// Dos pasadas: la segunda corta la regla en perpendicular a su eje ya corregido, no a la línea de la IA.
export function refineRuler(frame: Frame, coarse: [Point, Point]): [Point, Point] | null {
  const ref = rulerColor(frame, coarse[0], coarse[1]);
  if (!ref) return null;
  const first = refinePass(frame, coarse, ref);
  return first ? (refinePass(frame, first, ref) ?? first) : null;
}

function refinePass(frame: Frame, coarse: [Point, Point], ref: Hsv): [Point, Point] | null {
  const [a, b] = coarse;
  const coarseLength = Math.hypot(b.x - a.x, b.y - a.y);
  if (coarseLength < 20) return null;
  const u ={ x: (b.x - a.x) / coarseLength, y: (b.y - a.y) / coarseLength };
  const normal = { x: -u.y, y: u.x };

  let centers: Point[] = [];
  for (let i = 1; i < CROSS_SECTIONS; i++) {
    const base = { x: a.x + u.x * (coarseLength * i) / CROSS_SECTIONS, y: a.y + u.y * (coarseLength * i) / CROSS_SECTIONS };
    const center = crossSectionCenter(frame, base, normal, ref);
    if (center) centers.push(center);
  }
  if (centers.length < 5) return null;

  let line = fitLine(centers);
  const distance = (p: Point) => Math.abs((p.x - line.mean.x) * -line.dir.y + (p.y - line.mean.y) * line.dir.x);
  const inliers = centers.filter((p) => distance(p) <= OUTLIER_PX);
  if (inliers.length >= 5 && inliers.length < centers.length) {
    centers = inliers;
    line = fitLine(centers);
  }

  const side = { x: -line.dir.y, y: line.dir.x };
  const onRuler = (p: Point) =>
    [-2, 0, 2].some((offset) => {
      const c = colorAt(frame, { x: p.x + side.x * offset, y: p.y + side.y * offset });
      return c !== null && similar(c, ref);
    });
  const march = (sign: number): Point => {
    let last = 0;
    for (let s = 0; s <= coarseLength * 1.5; s += 0.5) {
      const p = { x: line.mean.x + line.dir.x * s * sign, y: line.mean.y + line.dir.y * s * sign };
      if (onRuler(p)) last = s;
      else if (s - last > MAX_GAP_PX) break;
    }
    return { x: line.mean.x + line.dir.x * last * sign, y: line.mean.y + line.dir.y * last * sign };
  };

  const ends = [march(-1), march(1)];
  const length = Math.hypot(ends[1].x - ends[0].x, ends[1].y - ends[0].y);
  // Si el resultado difiere mucho de lo que vio la IA, probablemente siguió otro objeto.
  if (Math.abs(length - coarseLength) > coarseLength * 0.25) return null;
  const first = Math.hypot(ends[0].x - a.x, ends[0].y - a.y) <= Math.hypot(ends[1].x - a.x, ends[1].y - a.y) ? 0 : 1;
  return [ends[first], ends[1 - first]];
}
