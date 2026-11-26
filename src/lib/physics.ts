export type Point = { x: number; y: number };
export type Box = { xmin: number; ymin: number; xmax: number; ymax: number };
export type Detection = Point & { t: number; box?: Box };

export type QuadraticFit = {
  a: number;
  uA: number;
  r2: number;
  rmse: number;
  at: (t: number) => number;
  velocityAt: (t: number) => number;
  // Incertidumbre estadística de la velocidad del ajuste en un instante.
  velocityU: (t: number) => number;
};

function invert3(m: number[][]): number[][] | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-18) return null;
  return [
    [A / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [C / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

export function fitQuadratic(t: number[], s: number[]): QuadraticFit | null {
  const n = t.length;
  if (n < 4) return null;
  // Centrar el tiempo evita una matriz mal condicionada; no altera el coeficiente cuadrático.
  const tMean = t.reduce((sum, v) => sum + v, 0) / n;
  const tc = t.map((v) => v - tMean);

  const S = [0, 0, 0, 0, 0];
  const T = [0, 0, 0];
  tc.forEach((v, k) => {
    for (let p = 0; p <= 4; p++) S[p] += v ** p;
    for (let p = 0; p <= 2; p++) T[p] += s[k] * v ** p;
  });

  const inverse = invert3([
    [S[0], S[1], S[2]],
    [S[1], S[2], S[3]],
    [S[2], S[3], S[4]],
  ]);
  if (!inverse) return null;

  const [c0, c1, c2] = inverse.map((row) => row[0] * T[0] + row[1] * T[1] + row[2] * T[2]);
  const at = (time: number) => {
    const v = time - tMean;
    return c0 + c1 * v + c2 * v * v;
  };

  const sMean = s.reduce((sum, v) => sum + v, 0) / n;
  let residual = 0;
  let total = 0;
  t.forEach((time, k) => {
    residual += (s[k] - at(time)) ** 2;
    total += (s[k] - sMean) ** 2;
  });

  const variance = n > 3 ? residual / (n - 3) : 0;
  return {
    a: 2 * c2,
    uA: 2 * Math.sqrt(Math.max(variance * inverse[2][2], 0)),
    r2: total > 0 ? 1 - residual / total : 0,
    rmse: Math.sqrt(residual / n),
    at,
    velocityAt: (time) => c1 + 2 * c2 * (time - tMean),
    // v = c1 + 2·c2·τ: su varianza sale de la covarianza de los coeficientes, σ²·inverse.
    velocityU: (time) => {
      const tau = time - tMean;
      return Math.sqrt(Math.max(variance * (inverse[1][1] + 4 * tau * inverse[1][2] + 4 * tau * tau * inverse[2][2]), 0));
    },
  };
}

// Ajuste cuadrático por ventana deslizante (equivale a un filtro Savitzky-Golay con tiempos no uniformes).
export function localDerivatives(t: number[], s: number[]) {
  const half = t.length >= 25 ? 4 : 2;
  const velocity: Point[] = [];
  const acceleration: Point[] = [];
  for (let i = half; i < t.length - half; i++) {
    const fit = fitQuadratic(t.slice(i - half, i + half + 1), s.slice(i - half, i + half + 1));
    if (!fit) continue;
    velocity.push({ x: t[i], y: fit.velocityAt(t[i]) });
    acceleration.push({ x: t[i], y: fit.a });
  }
  return { velocity, acceleration };
}

// La regla define el eje del movimiento: las posiciones se proyectan sobre ella y se convierten a metros.
export function toRampAxis(detections: Detection[], ruler: [Point, Point], metersPerPixel: number) {
  const [p0, p1] = ruler;
  const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const ux = (p1.x - p0.x) / length;
  const uy = (p1.y - p0.y) / length;
  const raw = detections.map((d) => ((d.x - p0.x) * ux + (d.y - p0.y) * uy) * metersPerPixel);
  if (raw.length === 0) return raw;
  const direction = raw[raw.length - 1] >= raw[0] ? 1 : -1;
  return raw.map((v) => (v - raw[0]) * direction);
}

export function trackingError(detections: Detection[], marks: Detection[], metersPerPixel: number) {
  const byTime = new Map(detections.map((d) => [d.t, d]));
  const differences = marks.flatMap((mark) => {
    const detection = byTime.get(mark.t);
    return detection ? [{ x: detection.x - mark.x, y: detection.y - mark.y }] : [];
  });
  const count = differences.length;
  if (count === 0) return null;

  // Cada método sigue un punto distinto del carrito: el desfase fijo se separa del error que varía.
  const offsetX = differences.reduce((sum, d) => sum + d.x, 0) / count;
  const offsetY = differences.reduce((sum, d) => sum + d.y, 0) / count;
  const rmse = (cx: number, cy: number) =>
    Math.sqrt(differences.reduce((sum, d) => sum + (d.x - cx) ** 2 + (d.y - cy) ** 2, 0) / count);

  const rmsePixels = rmse(0, 0);
  const rmseNoOffsetPixels = rmse(offsetX, offsetY);
  const offsetPixels = Math.hypot(offsetX, offsetY);
  // Se cumple rmse² = desfase² + variación²: el error total se reparte en sistemático y aleatorio.
  return {
    count,
    rmsePixels,
    rmseMeters: rmsePixels * metersPerPixel,
    rmseNoOffsetPixels,
    rmseNoOffsetMeters: rmseNoOffsetPixels * metersPerPixel,
    offsetPixels,
    offsetMeters: offsetPixels * metersPerPixel,
  };
}

// Error de cada detección respecto de la marca manual, a lo largo de la rampa y en mm.
// Positivo: la detección va por delante de la marca, en el sentido en que avanza el carrito.
export function alongRampErrors(detections: Detection[], marks: Detection[], ruler: [Point, Point], metersPerPixel: number) {
  const [p0, p1] = ruler;
  const length = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const ux = (p1.x - p0.x) / length;
  const uy = (p1.y - p0.y) / length;
  const ordered = [...marks].sort((a, b) => a.t - b.t);
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const travel = ordered.length > 1 ? (last.x - first.x) * ux + (last.y - first.y) * uy : 0;
  const direction = travel >= 0 ? 1 : -1;
  const byTime = new Map(detections.map((d) => [d.t, d]));
  return marks.flatMap((mark) => {
    const detection = byTime.get(mark.t);
    if (!detection) return [];
    const along = (detection.x - mark.x) * ux + (detection.y - mark.y) * uy;
    return [{ t: mark.t, mm: along * direction * metersPerPixel * 1000 }];
  });
}

export type Measured = { value: number; u: number };

export type CartModel = {
  thetaDeg: number;
  uThetaDeg: number;
  g: number;
  mu: number;
  uMu: number;
  // I/(M·R²): inercia de todas las ruedas respecto de la masa total del carrito.
  inertiaRatio: number;
};

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

// Con I = k·m·r² por rueda y R = r, el radio se cancela: I/(M·R²) = n·k·m/M.
export function wheelInertiaRatio(totalMass: number, wheelCount: number, wheelMass: number, shapeFactor: number) {
  return (wheelCount * shapeFactor * wheelMass) / totalMass;
}

// a = g(sinθ − μ·cosθ)/(1 + I/MR²), con incertidumbre propagada desde θ y μ.
export function theoreticalAcceleration(model: CartModel): Measured {
  const theta = toRadians(model.thetaDeg);
  const scale = model.g / (1 + model.inertiaRatio);
  const dTheta = scale * (Math.cos(theta) + model.mu * Math.sin(theta));
  const dMu = -scale * Math.cos(theta);
  return {
    value: scale * (Math.sin(theta) - model.mu * Math.cos(theta)),
    u: Math.hypot(dTheta * toRadians(model.uThetaDeg), dMu * model.uMu),
  };
}

// Despeja μ del modelo con la aceleración medida; en plano (θ = 0) es la medición directa de la resistencia.
export function resistanceFromAcceleration(a: Measured, model: CartModel): Measured {
  const theta = toRadians(model.thetaDeg);
  const factor = (1 + model.inertiaRatio) / (model.g * Math.cos(theta));
  const dTheta = 1 / Math.cos(theta) ** 2 - a.value * factor * Math.tan(theta);
  return {
    value: Math.tan(theta) - a.value * factor,
    u: Math.hypot(factor * a.u, dTheta * toRadians(model.uThetaDeg)),
  };
}

// Diferencia en número de incertidumbres combinadas: menos de 2 se considera compatible.
export function discrepancy(a: Measured, b: Measured) {
  const combined = Math.hypot(a.u, b.u);
  return combined > 0 ? Math.abs(a.value - b.value) / combined : null;
}
