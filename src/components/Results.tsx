"use client";

import { useMemo, useState } from "react";
import {
  alongRampErrors,
  discrepancy,
  fitLinear,
  fitQuadratic,
  localDerivatives,
  repeatStats,
  resistanceFromAcceleration,
  runsTest,
  theoreticalAcceleration,
  toRampAxis,
  trackingError,
  type CartModel,
  type Detection,
  type Measured,
  type Point,
} from "@/lib/physics";
import { KinematicsChart, type ChartSeries } from "./KinematicsChart";
import type { RunEntry } from "@/lib/runStore";

export type RawRun = {
  colorDetections: Detection[];
  geminiDetections: Detection[];
  totalSamples: number;
  geminiRequested: number;
  colorMs: number;
  geminiMs: number;
  extractionMs: number;
  usedColor: boolean;
  usedGemini: boolean;
  ruler: [Point, Point];
  metersPerPixel: number;
  calibrationRelativeUncertainty: number;
  fps: number;
  video: string;
  model: CartModel;
};

const MIN_FRAMES_WITHOUT_OFFSET = 3;
const MIN_COMMON_FRAMES = 4;
const COMPATIBLE_SIGMAS = 2;
// El término cuadrático se acepta si a es al menos este número de veces su incertidumbre estadística.
const SIGNIFICANT_SIGMAS = 2;
// Con z por debajo de −2 en la prueba de rachas, los residuos tienen un patrón.
const RUNS_PATTERN_Z = -2;

type ChartId = "position" | "velocity" | "acceleration" | "residuals" | "error";

const METHODS = [
  { key: "color", label: "Convencional (color)", colorVar: "--series-1" },
  { key: "gemini", label: "IA (Gemini)", colorVar: "--series-2" },
] as const;

function analyzeMethod(detections: Detection[], run: RawRun) {
  const times = detections.map((d) => d.t);
  const positions = toRampAxis(detections, run.ruler, run.metersPerPixel);
  const fit = fitQuadratic(times, positions);
  if (!fit) return null;
  // La escala de la regla multiplica todas las posiciones: su error relativo pasa igual a x₀, v y a.
  const scaled = (value: number, statistical: number): Measured => ({
    value,
    u: Math.hypot(statistical, value * run.calibrationRelativeUncertainty),
  });
  const acceleration = scaled(fit.a, fit.uA);
  const start = times[0];
  const end = times[times.length - 1];
  const residuals = times.map((t, i) => positions[i] - fit.at(t));
  return {
    times,
    positions,
    fit,
    acceleration,
    // Las dos partes de la incertidumbre de a, antes de combinarlas.
    uncertainty: { fit: fit.uA, calibration: Math.abs(fit.a) * run.calibrationRelativeUncertainty },
    residuals,
    local: localDerivatives(times, positions),
    resistance: resistanceFromAcceleration(acceleration, run.model),
    motion: {
      x0: scaled(fit.at(start), fit.positionU(start)),
      v0: scaled(fit.velocityAt(start), fit.velocityU(start)),
      vf: scaled(fit.velocityAt(end), fit.velocityU(end)),
      distance: fit.at(end) - fit.at(start),
      duration: end - start,
    },
    model: {
      linearRmse: fitLinear(times, positions)?.rmse ?? null,
      significance: fit.uA > 0 ? Math.abs(fit.a) / fit.uA : null,
      runs: runsTest(residuals),
    },
  };
}

function curve(start: number, end: number, value: (t: number) => number): Point[] {
  return Array.from({ length: 50 }, (_, i) => {
    const x = start + ((end - start) * i) / 49;
    return { x, y: value(x) };
  });
}

function downloadCsv(run: RawRun, marks: Detection[]) {
  const rows = ["metodo,t_s,x_px,y_px,posicion_m"];
  const add = (name: string, detections: Detection[]) => {
    const positions = toRampAxis(detections, run.ruler, run.metersPerPixel);
    detections.forEach((d, i) => rows.push(`${name},${d.t.toFixed(4)},${d.x.toFixed(2)},${d.y.toFixed(2)},${positions[i].toFixed(5)}`));
  };
  add("convencional", run.colorDetections);
  add("gemini", run.geminiDetections);
  add("manual", marks);
  const url = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "datos-carrito.csv";
  link.click();
  URL.revokeObjectURL(url);
}

type Props = { run: RawRun; marks: Detection[]; savedRuns: RunEntry[]; onSave: (entries: RunEntry[]) => void };

export function Results({ run, marks, savedRuns, onSave }: Props) {
  const [savedFor, setSavedFor] = useState<{ marks: Detection[]; matched: boolean } | null>(null);
  const [chart, setChart] = useState<ChartId>("position");
  const [sameFrames, setSameFrames] = useState(false);
  const bothUsed = run.usedColor && run.usedGemini;
  const commonCount = useMemo(() => {
    const geminiTimes = new Set(run.geminiDetections.map((d) => d.t));
    return run.colorDetections.filter((d) => geminiTimes.has(d.t)).length;
  }, [run]);
  const canMatch = bothUsed && commonCount >= MIN_COMMON_FRAMES;
  const matched = sameFrames && canMatch;

  // Con "los mismos fotogramas" cada método se queda solo con los que el otro también detectó.
  const frames = useMemo(() => {
    if (!matched) return { color: run.colorDetections, gemini: run.geminiDetections };
    const geminiTimes = new Set(run.geminiDetections.map((d) => d.t));
    const colorTimes = new Set(run.colorDetections.map((d) => d.t));
    return {
      color: run.colorDetections.filter((d) => geminiTimes.has(d.t)),
      gemini: run.geminiDetections.filter((d) => colorTimes.has(d.t)),
    };
  }, [run, matched]);

  const tracking = useMemo(
    () => ({
      color: trackingError(frames.color, marks, run.metersPerPixel),
      gemini: trackingError(frames.gemini, marks, run.metersPerPixel),
    }),
    [frames, marks, run.metersPerPixel],
  );
  const color = useMemo(() => analyzeMethod(frames.color, run), [frames, run]);
  const gemini = useMemo(() => analyzeMethod(frames.gemini, run), [frames, run]);
  const theory = useMemo(() => theoreticalAcceleration(run.model), [run]);
  // Cuánto aporta cada dato de entrada a la incertidumbre teórica.
  const theoryParts = useMemo(
    () => ({
      theta: theoreticalAcceleration({ ...run.model, uMu: 0 }).u,
      mu: theoreticalAcceleration({ ...run.model, uThetaDeg: 0 }).u,
    }),
    [run],
  );
  const analyses = { color, gemini };
  const isFlat = run.model.thetaDeg === 0;

  const charts = useMemo(() => {
    const position: ChartSeries[] = [];
    const velocity: ChartSeries[] = [];
    const acceleration: ChartSeries[] = [];
    const residuals: ChartSeries[] = [];
    let tMin = Infinity;
    let tMax = -Infinity;
    for (const method of METHODS) {
      const result = method.key === "color" ? color : gemini;
      if (!result) continue;
      const first = result.times[0];
      const last = result.times[result.times.length - 1];
      tMin = Math.min(tMin, first);
      tMax = Math.max(tMax, last);
      const base = { colorVar: method.colorVar };
      position.push(
        { ...base, label: `${method.label}: medido`, style: "points", points: result.times.map((t, i) => ({ x: t, y: result.positions[i] })) },
        { ...base, label: `${method.label}: ajuste`, style: "line", points: curve(first, last, result.fit.at) },
      );
      velocity.push(
        { ...base, label: `${method.label}: medido`, style: "points", points: result.local.velocity },
        { ...base, label: `${method.label}: ajuste`, style: "line", points: curve(first, last, result.fit.velocityAt) },
      );
      acceleration.push(
        { ...base, label: `${method.label}: medido`, style: "points", points: result.local.acceleration },
        { ...base, label: `${method.label}: ajuste`, style: "line", points: curve(first, last, () => result.fit.a) },
      );
      residuals.push({ ...base, label: method.label, style: "points", points: result.times.map((t, i) => ({ x: t, y: result.residuals[i] * 1000 })) });
    }
    if (acceleration.length > 0) {
      acceleration.push({ label: "Teórica (modelo)", colorVar: "--ink-2", style: "dashed", points: curve(tMin, tMax, () => theory.value) });
      residuals.push({ label: "Cero", colorVar: "--ink-2", style: "dashed", points: [{ x: tMin, y: 0 }, { x: tMax, y: 0 }] });
    }

    const error: ChartSeries[] = [];
    if (marks.length > 0) {
      for (const method of METHODS) {
        const detections = method.key === "color" ? frames.color : frames.gemini;
        const visible = method.key === "color" ? run.usedColor : run.usedGemini;
        const points = visible ? alongRampErrors(detections, marks, run.ruler, run.metersPerPixel).map((e) => ({ x: e.t, y: e.mm })) : [];
        if (points.length > 0) error.push({ colorVar: method.colorVar, label: method.label, style: "points", points });
      }
      const times = marks.map((m) => m.t);
      error.push({ label: "Sin error", colorVar: "--ink-2", style: "dashed", points: [{ x: Math.min(...times), y: 0 }, { x: Math.max(...times), y: 0 }] });
    }
    return { position, velocity, acceleration, residuals, error };
  }, [color, gemini, theory, frames, marks, run]);

  const betweenMethods = useMemo(() => {
    if (!color || !gemini) return null;
    const byTime = new Map(color.times.map((t, i) => [t, color.positions[i]]));
    const pairs = gemini.times.flatMap((t, i) => {
      const other = byTime.get(t);
      return other === undefined ? [] : [gemini.positions[i] - other];
    });
    if (pairs.length === 0) return null;
    // El centro de la caja de Gemini y la marca de color son puntos distintos del carrito: se quita ese desfase fijo.
    const offset = pairs.reduce((sum, v) => sum + v, 0) / pairs.length;
    const rmse = Math.sqrt(pairs.reduce((sum, v) => sum + (v - offset) ** 2, 0) / pairs.length);
    return {
      rmse,
      accelerationDifference: Math.abs(gemini.acceleration.value - color.acceleration.value),
      sigmas: discrepancy(color.acceleration, gemini.acceleration),
    };
  }, [color, gemini]);

  const visibleMethods = METHODS.filter((method) => (method.key === "color" ? run.usedColor : run.usedGemini));
  const msPerFrame = (key: "color" | "gemini") => {
    const count = key === "color" ? run.totalSamples : run.geminiRequested;
    return count > 0 ? (key === "color" ? run.colorMs : run.geminiMs) / count : null;
  };
  const differencePct = (a: Measured) => (theory.value === 0 ? null : ((a.value - theory.value) / Math.abs(theory.value)) * 100);
  // Con muy pocos fotogramas, separar desfase y variación da números sin sentido.
  const noOffsetError = (key: "color" | "gemini") => {
    const error = tracking[key];
    return error && error.count >= MIN_FRAMES_WITHOUT_OFFSET ? error.rmseNoOffsetMeters * 1000 : null;
  };
  const offsetError = (key: "color" | "gemini") => {
    const error = tracking[key];
    return error && error.count >= MIN_FRAMES_WITHOUT_OFFSET ? error.offsetMeters * 1000 : null;
  };

  const save = () => {
    const savedAt = new Date().toISOString();
    const entries = visibleMethods.flatMap((method) => {
      const result = analyses[method.key];
      if (!result) return [];
      const error = tracking[method.key];
      return [{
        id: `${savedAt}-${method.key}`,
        savedAt,
        video: run.video,
        thetaDeg: run.model.thetaDeg,
        method: matched ? `${method.label} · mismos fotogramas` : method.label,
        a: result.acceleration.value,
        uA: result.acceleration.u,
        uAFit: result.uncertainty.fit,
        uACalibration: result.uncertainty.calibration,
        v0: result.motion.v0.value,
        uV0: result.motion.v0.u,
        aTheory: theory.value,
        uTheory: theory.u,
        diffPct: differencePct(result.acceleration),
        sigmas: discrepancy(result.acceleration, theory),
        mu: result.resistance.value,
        uMu: result.resistance.u,
        r2: result.fit.r2,
        frames: result.times.length,
        msPerFrame: msPerFrame(method.key),
        manualRmseMm: error ? error.rmseMeters * 1000 : null,
        manualRmseNoOffsetMm: noOffsetError(method.key),
        manualOffsetMm: offsetError(method.key),
      }];
    });
    onSave(entries);
    setSavedFor({ marks, matched });
  };

  const row = (label: string, value: (key: "color" | "gemini") => string) => (
    <tr className="border-t border-line">
      <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink-2">{label}</th>
      {visibleMethods.map((method) => (
        <td key={method.key} className="py-1.5 pr-3 font-mono tabular-nums">{value(method.key)}</td>
      ))}
    </tr>
  );
  const metric = (key: "color" | "gemini", read: (r: NonNullable<typeof color>) => string) => {
    const result = analyses[key];
    return result ? read(result) : "—";
  };
  const withU = (m: Measured, digits: number) => `${m.value.toFixed(digits)} ± ${m.u.toFixed(digits)}`;
  const sigmaText = (sigmas: number | null) =>
    sigmas === null ? "—" : `${sigmas.toFixed(1)} σ (${sigmas < COMPATIBLE_SIGMAS ? "compatible" : "no compatible"})`;
  const saved = savedFor?.marks === marks && savedFor.matched === matched;

  const table = (rows: React.ReactNode) => (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs">
            <th scope="col" className="pb-1.5 pr-3 font-medium text-ink-2">Medida</th>
            {visibleMethods.map((method) => (
              <th key={method.key} scope="col" className="pb-1.5 pr-3 font-semibold">{method.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
  const chartTabs: { id: ChartId; label: string }[] = [
    { id: "position", label: "Posición" },
    { id: "velocity", label: "Velocidad" },
    { id: "acceleration", label: "Aceleración" },
    { id: "residuals", label: "Residuos" },
    ...(marks.length > 0 ? [{ id: "error" as const, label: "Error de seguimiento" }] : []),
  ];
  const activeChart: ChartId = chart === "error" && marks.length === 0 ? "position" : chart;
  const frameCount = (key: "color" | "gemini") => (key === "color" ? frames.color.length : frames.gemini.length);

  const signed = (n: number, digits: number) => `${n < 0 ? "−" : "+"} ${Math.abs(n).toFixed(digits)}`;
  const predictedFinalSpeed = (r: NonNullable<typeof color>): Measured => ({
    value: r.motion.v0.value + theory.value * r.motion.duration,
    u: Math.hypot(r.motion.v0.u, theory.u * r.motion.duration),
  });
  // Promedio de μ de las corridas en plano ya guardadas, por método; cada video cuenta una sola vez.
  const flatFriction = (key: "color" | "gemini") => {
    const label = METHODS.find((m) => m.key === key)!.label;
    const items = savedRuns.filter((e) => e.thetaDeg === 0 && e.method === label).map((e) => ({ video: e.video, value: e.mu }));
    if (items.length === 0) return "—";
    const stats = repeatStats(items);
    const videos = `${stats.videos} ${stats.videos === 1 ? "video" : "videos"}`;
    return stats.sem === null ? `${stats.mean.toFixed(4)} (${videos})` : `${stats.mean.toFixed(4)} ± ${stats.sem.toFixed(4)} (${videos})`;
  };
  const modelChoice = (r: NonNullable<typeof color>) => {
    const { significance, runs } = r.model;
    if (significance === null) return "—";
    const chosen = significance >= SIGNIFICANT_SIGMAS ? "Aceleración constante" : "Velocidad constante";
    return runs && runs.z < RUNS_PATTERN_Z ? `${chosen}, pero con patrón` : chosen;
  };

  const motionCard = (color || gemini) && (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold">Ajuste del movimiento</h3>
      <div className="space-y-2 font-mono text-xs tabular-nums">
        {visibleMethods.map((method) => {
          const r = analyses[method.key];
          if (!r) return null;
          return (
            <div key={method.key} className="space-y-0.5">
              <p className="font-sans font-medium">
                <span aria-hidden className="mr-1.5 inline-block size-2 rounded-full" style={{ background: `var(${method.colorVar})` }} />
                {method.label}
              </p>
              <p>x(τ) = {r.motion.x0.value.toFixed(3)} {signed(r.motion.v0.value, 3)}·τ {signed(r.acceleration.value / 2, 3)}·τ²</p>
              <p>v(τ) = {r.motion.v0.value.toFixed(3)} {signed(r.acceleration.value, 3)}·τ</p>
            </div>
          );
        })}
      </div>
      {table(
        <>
          {row("x₀: posición inicial (m)", (k) => metric(k, (r) => withU(r.motion.x0, 4)))}
          {row("v₀: velocidad inicial (m/s)", (k) => metric(k, (r) => withU(r.motion.v0, 3)))}
          {row("a/2: coeficiente de τ² (m/s²)", (k) => metric(k, (r) => withU({ value: r.acceleration.value / 2, u: r.acceleration.u / 2 }, 4)))}
          {row("a = 2·(a/2): aceleración (m/s²)", (k) => metric(k, (r) => withU(r.acceleration, 3)))}
        </>,
      )}
      <ul className="list-disc space-y-1 pl-4 text-xs text-ink-2">
        <li>
          <span className="font-medium text-foreground">Sistema de referencia:</span> eje x a lo largo de la regla, positivo en el sentido en que avanza el carrito; origen x = 0 donde se detectó el carrito en el primer fotograma del tramo; τ = t − t₀ en segundos, con t₀ el inicio del tramo.
        </li>
        <li><span className="font-medium text-foreground">x₀</span> es dónde estaba el carrito en τ = 0 según el ajuste. Sale casi 0 por la elección del origen; no es exactamente 0 porque la primera detección tiene error.</li>
        <li><span className="font-medium text-foreground">v₀</span> es la velocidad en τ = 0: casi 0 si el carrito se soltó desde el reposo al inicio del tramo.</li>
        <li><span className="font-medium text-foreground">a/2</span> es la mitad de la aceleración, porque x = x₀ + v₀τ + ½aτ². Su doble es la aceleración que se compara con la teoría.</li>
        <li>
          <span className="font-medium text-foreground">¿Por qué una parábola?</span> En un plano recto con ángulo fijo, el peso, la normal y la resistencia son constantes, así que la fuerza neta y la aceleración también lo son, y la posición queda cuadrática en el tiempo. Vale solo mientras el carrito avanza libre: sin empujones, sin chocar con el tope y sin una resistencia que crezca con la velocidad. La tarjeta «¿Qué modelo describe el movimiento?» lo comprueba con los datos.
        </li>
      </ul>
      <p className="text-xs text-ink-2">Cada ± combina la dispersión de los puntos alrededor del ajuste con la incertidumbre de la regla.</p>
      {table(
        <>
          {row("Velocidad final v_f (m/s)", (k) => metric(k, (r) => withU(r.motion.vf, 3)))}
          {row("v_f que predice el modelo (m/s)", (k) => metric(k, (r) => withU(predictedFinalSpeed(r), 3)))}
          {row("Distancia en el tramo (m)", (k) => metric(k, (r) => r.motion.distance.toFixed(3)))}
          {row("Duración del tramo (s)", (k) => metric(k, (r) => r.motion.duration.toFixed(2)))}
        </>,
      )}
      <p className="text-xs text-ink-2">La v_f del modelo es v₀ medida + a teórica · duración; así se ve cuánto se aleja la realidad de la predicción.</p>
    </div>
  );

  const modelCard = (color || gemini) && (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold">¿Qué modelo describe el movimiento?</h3>
      {table(
        <>
          {row("Residuo con velocidad constante (mm)", (k) => metric(k, (r) => (r.model.linearRmse === null ? "—" : (r.model.linearRmse * 1000).toFixed(2))))}
          {row("Residuo con aceleración constante (mm)", (k) => metric(k, (r) => (r.fit.rmse * 1000).toFixed(2)))}
          {row("a comparada con su incertidumbre", (k) => metric(k, (r) => (r.model.significance === null ? "—" : `${r.model.significance.toFixed(1)} veces`)))}
          {row("Residuos sin patrón (rachas)", (k) => metric(k, (r) => {
            const runs = r.model.runs;
            if (!runs) return "pocos datos";
            return `${runs.z < RUNS_PATTERN_Z ? "no" : "sí"} (${runs.runs} de ~${runs.expected.toFixed(0)})`;
          }))}
          {row("Modelo que eligen los datos", (k) => metric(k, modelChoice))}
        </>,
      )}
      <ul className="list-disc space-y-1 pl-4 text-xs text-ink-2">
        <li>
          Se prueban dos modelos: <span className="font-mono">x = x₀ + v·τ</span> (velocidad constante) y <span className="font-mono">x = x₀ + v₀τ + ½aτ²</span> (aceleración constante). El residuo es cuánto se separan, en promedio, los puntos de cada curva.
        </li>
        <li>
          Una curva con más parámetros siempre ajusta un poco mejor. Por eso la aceleración constante solo se elige si a es al menos {SIGNIFICANT_SIGMAS} veces su incertidumbre; si no, la diferencia podría ser solo ruido.
        </li>
        <li>
          Si el modelo es correcto, los residuos (pestaña <span className="font-medium text-foreground">Residuos</span>) quedan como ruido alrededor de cero y cambian de signo a menudo (rachas). Pocas rachas (residuos agrupados en forma de U, de S o de serrucho) indican que falta algo: la aceleración cambió en el tramo, hubo un choque, la cámara deforma la escala o el video tiene fps variable (muchos celulares graban así) y los fotogramas no están igual de espaciados en el tiempo.
        </li>
        <li>
          <span className="font-medium text-foreground">Un R² cercano a 1 no garantiza que a sea exacta.</span> Un error de escala, como una cámara no perpendicular o una regla fuera del plano del carrito, cambia a en el mismo porcentaje sin empeorar el ajuste. Por eso dos métodos pueden tener R² ≈ 1 y aceleraciones distintas.
        </li>
      </ul>
    </div>
  );

  const frictionCard = (color || gemini) && (
    <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <h3 className="text-sm font-semibold">Coeficiente de rozamiento μ</h3>
      {table(
        <>
          {row(isFlat ? "μ de esta corrida (en plano)" : "μ que explicaría esta medición", (k) => metric(k, (r) => withU(r.resistance, 4)))}
          {row("Promedio de corridas en plano guardadas", (k) => flatFriction(k))}
        </>,
      )}
      <p className="text-xs text-ink-2">
        {isFlat
          ? "En plano, μ sale de la desaceleración: μ = |a|·(1 + I/MR²) / g. Para usarlo en las corridas en rampa, copia en la pestaña Carrito el promedio de varias grabaciones guardadas. El ± del promedio es el error de la media entre videos distintos: analizar otra vez el mismo video no cuenta como repetición."
          : "Es el μ que haría coincidir el modelo con esta medición. Para validar el modelo, compáralo con el μ medido en plano."}
      </p>
      <p className="text-xs text-ink-2">
        Con ruedas, μ resume la resistencia a la rodadura (incluida la fricción en los ejes), no la fricción de deslizamiento. Si el carrito se desliza sin ruedas (sin masa de ruedas en la pestaña Carrito), μ es el coeficiente de fricción cinética.
      </p>
    </div>
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Resultados</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={save} disabled={saved || (!color && !gemini)} className="btn">
            {saved ? "Corrida guardada" : "Guardar en corridas"}
          </button>
          <button type="button" onClick={() => downloadCsv(run, marks)} className="btn">Descargar datos (CSV)</button>
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,32rem)_minmax(0,1fr)]">
        <div className="space-y-3 rounded-lg border border-line bg-surface p-4">
          <p className="text-xs text-ink-2">
            <span className="font-semibold text-foreground">Teoría: </span>
            <span className="font-mono tabular-nums text-foreground">a = {withU(theory, 3)} m/s²</span>
            {` (± por θ: ${theoryParts.theta.toFixed(3)}, por μ: ${theoryParts.mu.toFixed(3)})`}
            {` · θ = ${run.model.thetaDeg}° ± ${run.model.uThetaDeg}°, μ = ${run.model.mu} ± ${run.model.uMu}, I/MR² = ${run.model.inertiaRatio.toFixed(4)}, g = ${run.model.g}`}
          </p>
          {isFlat && run.model.mu === 0 && (
            <p className="rounded-md bg-background px-3 py-2 text-xs">
              En plano y con μ = 0 la teoría predice a = 0: usa esta corrida para medir μ y copia el valor de «μ medido en plano» en la pestaña Carrito.
            </p>
          )}
          {bothUsed && (
            <div className="space-y-1.5">
              <div role="group" aria-label="Fotogramas que se comparan" className="grid grid-cols-2 gap-1 rounded-md border border-line p-1">
                {[
                  { value: false, label: "Los de cada método" },
                  { value: true, label: `Los mismos en ambos (${commonCount})` },
                ].map((option) => (
                  <button
                    key={String(option.value)}
                    type="button"
                    aria-pressed={matched === option.value}
                    disabled={option.value && !canMatch}
                    onClick={() => setSameFrames(option.value)}
                    className={`rounded px-2 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
                      matched === option.value ? "bg-[var(--series-1)] text-white" : "text-ink-2 hover:bg-background"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-ink-2">
                {matched
                  ? `Los dos métodos usan exactamente los mismos ${commonCount} fotogramas: la diferencia viene solo del detector.`
                  : canMatch
                    ? `Color usa ${run.colorDetections.length} fotogramas y Gemini ${run.geminiDetections.length}: la diferencia también puede venir de la cantidad de datos.`
                    : "No hay suficientes fotogramas detectados por ambos métodos para compararlos con los mismos."}
              </p>
            </div>
          )}
          {table(
            <>
              {row("Aceleración medida (m/s²)", (k) => metric(k, (r) => withU(r.acceleration, 3)))}
              {row("   ± por el ajuste (puntos)", (k) => metric(k, (r) => r.uncertainty.fit.toFixed(3)))}
              {row("   ± por la regla (escala)", (k) => metric(k, (r) => r.uncertainty.calibration.toFixed(3)))}
              {row("Diferencia con la teoría", (k) => metric(k, (r) => {
                const pct = differencePct(r.acceleration);
                return pct === null ? "—" : `${pct.toFixed(1)} %`;
              }))}
              {row("Discrepancia", (k) => metric(k, (r) => sigmaText(discrepancy(r.acceleration, theory))))}
              {row("R² del ajuste", (k) => metric(k, (r) => r.fit.r2.toFixed(4)))}
              {row(isFlat ? "μ medido en plano" : "μ que explicaría la medición", (k) => metric(k, (r) => withU(r.resistance, 4)))}
              {marks.length > 0 && (
                <>
                  {row("Error total vs. marcado manual (mm)", (k) => (tracking[k] ? (tracking[k].rmseMeters * 1000).toFixed(1) : "—"))}
                  {row("   Sistemático: desfase fijo (mm)", (k) => offsetError(k)?.toFixed(1) ?? "—")}
                  {row("   Aleatorio: variación (mm)", (k) => noOffsetError(k)?.toFixed(1) ?? "—")}
                </>
              )}
            </>,
          )}
          <p className="text-xs text-ink-2">
            El ± de a junta dos fuentes de este video: la dispersión de los puntos alrededor del ajuste y la incertidumbre de la regla. <span className="font-medium text-foreground">No incluye</span> el error por perspectiva (cámara no perpendicular) ni la variación entre grabaciones distintas: esa se ve guardando varios videos en «Corridas guardadas».
          </p>
          {marks.length > 0 && (
            <p className="text-xs text-ink-2">
              El <span className="font-medium text-foreground">desfase fijo</span> es el error que se repite igual en todos los fotogramas (por ejemplo, Gemini marca el centro de la caja del carrito y el método por color, el centro de la marca). La <span className="font-medium text-foreground">variación</span> es lo que cambia de un fotograma a otro. Se cumple: total² = desfase² + variación². Con menos de {MIN_FRAMES_WITHOUT_OFFSET} fotogramas marcados no se separan.
            </p>
          )}
          {betweenMethods && (
            <p className="rounded-md bg-background px-3 py-2 text-xs">
              <span className="font-semibold">Entre los dos métodos: </span>
              la aceleración difiere en <span className="font-mono tabular-nums">{betweenMethods.accelerationDifference.toFixed(3)} m/s²</span> ({sigmaText(betweenMethods.sigmas)}) y la posición varía <span className="font-mono tabular-nums">{(betweenMethods.rmse * 1000).toFixed(1)} mm</span>, sin contar el desfase fijo.
            </p>
          )}
          <details className="group text-sm">
            <summary className="cursor-pointer text-xs font-medium text-ink-2 hover:text-foreground">Más detalles del ajuste y de los tiempos</summary>
            <div className="mt-3 space-y-3">
              {table(
                <>
                  {row("Residuo del ajuste (mm)", (k) => metric(k, (r) => (r.fit.rmse * 1000).toFixed(2)))}
                  {row("Fotogramas usados", (k) =>
                    matched
                      ? `${frameCount(k)} (los mismos)`
                      : k === "color"
                        ? `${run.colorDetections.length} de ${run.totalSamples}`
                        : `${run.geminiDetections.length} de ${run.geminiRequested}`,
                  )}
                  {row("Tiempo del método (ms)", (k) => (k === "color" ? run.colorMs.toFixed(0) : run.geminiMs.toFixed(0)))}
                  {row("Tiempo por fotograma (ms)", (k) => msPerFrame(k)?.toFixed(1) ?? "—")}
                  {marks.length > 0 && (
                    <>
                      {row("Error vs. marcado manual (px)", (k) => tracking[k]?.rmsePixels.toFixed(1) ?? "—")}
                      {row("Fotogramas comparados", (k) => String(tracking[k]?.count ?? 0))}
                    </>
                  )}
                </>,
              )}
              <p className="text-xs text-ink-2">
                La incertidumbre medida combina el error del ajuste con el de calibración; la teórica viene de θ y μ. Menos de {COMPATIBLE_SIGMAS} σ de discrepancia es compatible.
                {` Extraer los fotogramas tomó ${run.extractionMs.toFixed(0)} ms, fuera del tiempo de los métodos.`}
              </p>
            </div>
          </details>
          {marks.length === 0 && <p className="text-xs text-ink-2">Para guardar el error de seguimiento, marca fotogramas a mano antes de guardar la corrida.</p>}
        </div>

        <div className="min-w-0 space-y-4">
        {charts.position.length > 0 && (
          <div className="min-w-0 rounded-lg border border-line bg-surface p-4">
            <div role="tablist" aria-label="Gráfica" className="mb-3 inline-flex flex-wrap rounded-md border border-line p-0.5">
              {chartTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeChart === tab.id}
                  onClick={() => setChart(tab.id)}
                  className={`rounded px-3 py-1 text-xs font-medium ${activeChart === tab.id ? "bg-[var(--series-1)] text-white" : "text-ink-2 hover:text-foreground"}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {activeChart === "position" && (
              <KinematicsChart
                title="Posición sobre la rampa"
                hint="Puntos: posición medida en cada fotograma. Línea: parábola ajustada."
                yLabel="Posición (m)"
                unit="m"
                series={charts.position}
              />
            )}
            {activeChart === "velocity" && (
              <KinematicsChart
                title="Velocidad"
                hint="Puntos: calculados con posiciones vecinas. Línea: derivada del ajuste; recta si la aceleración es constante."
                yLabel="Velocidad (m/s)"
                unit="m/s"
                series={charts.velocity}
              />
            )}
            {activeChart === "acceleration" && (
              <KinematicsChart
                title="Aceleración"
                hint="Puntos: calculados con posiciones vecinas. Línea continua: ajuste. Punteada: teoría con rotación y resistencia."
                yLabel="Aceleración (m/s²)"
                unit="m/s²"
                series={charts.acceleration}
              />
            )}
            {activeChart === "residuals" && (
              <KinematicsChart
                title="Residuos del ajuste"
                hint="Posición medida menos la parábola ajustada. Si el modelo es correcto, los puntos quedan al azar alrededor de cero; una forma de U o de S indica que la aceleración no fue constante o que la escala cambia a lo largo de la imagen; un serrucho, que los fotogramas no están igual de espaciados (fps variable)."
                yLabel="Medido − ajuste (mm)"
                unit="mm"
                series={charts.residuals}
              />
            )}
            {activeChart === "error" && (
              <KinematicsChart
                title="Error de seguimiento"
                hint="Cada punto es un fotograma marcado a mano: detectado menos marcado, a lo largo de la rampa (positivo = la detección va por delante). Puntos alejados de la línea de cero: error sistemático. Puntos dispersos: error aleatorio."
                yLabel="Detectado − marcado (mm)"
                unit="mm"
                series={charts.error}
              />
            )}
          </div>
        )}
        {motionCard}
        {modelCard}
        {frictionCard}
        </div>
      </div>
    </section>
  );
}
