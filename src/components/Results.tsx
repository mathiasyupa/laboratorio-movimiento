"use client";

import { useMemo, useState } from "react";
import {
  alongRampErrors,
  discrepancy,
  fitQuadratic,
  localDerivatives,
  resistanceFromAcceleration,
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

type ChartId = "position" | "velocity" | "acceleration" | "error";

const METHODS = [
  { key: "color", label: "Convencional (color)", colorVar: "--series-1" },
  { key: "gemini", label: "IA (Gemini)", colorVar: "--series-2" },
] as const;

function analyzeMethod(detections: Detection[], run: RawRun) {
  const times = detections.map((d) => d.t);
  const positions = toRampAxis(detections, run.ruler, run.metersPerPixel);
  const fit = fitQuadratic(times, positions);
  if (!fit) return null;
  // La escala multiplica todas las posiciones, así que su error relativo pasa igual a la aceleración.
  const acceleration: Measured = { value: fit.a, u: Math.hypot(fit.uA, fit.a * run.calibrationRelativeUncertainty) };
  // La velocidad también se mide con la escala de la regla, así que hereda su incertidumbre relativa.
  const speed = (t: number): Measured => {
    const value = fit.velocityAt(t);
    return { value, u: Math.hypot(fit.velocityU(t), value * run.calibrationRelativeUncertainty) };
  };
  const start = times[0];
  const end = times[times.length - 1];
  return {
    times,
    positions,
    fit,
    acceleration,
    local: localDerivatives(times, positions),
    resistance: resistanceFromAcceleration(acceleration, run.model),
    motion: {
      x0: fit.at(start),
      v0: speed(start),
      vf: speed(end),
      distance: fit.at(end) - fit.at(start),
      duration: end - start,
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
  const analyses = { color, gemini };
  const isFlat = run.model.thetaDeg === 0;

  const charts = useMemo(() => {
    const position: ChartSeries[] = [];
    const velocity: ChartSeries[] = [];
    const acceleration: ChartSeries[] = [];
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
    }
    if (acceleration.length > 0) {
      acceleration.push({ label: "Teórica (modelo)", colorVar: "--ink-2", style: "dashed", points: curve(tMin, tMax, () => theory.value) });
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
    return { position, velocity, acceleration, error };
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
    ...(marks.length > 0 ? [{ id: "error" as const, label: "Error de seguimiento" }] : []),
  ];
  const activeChart: ChartId = chart === "error" && marks.length === 0 ? "position" : chart;
  const frameCount = (key: "color" | "gemini") => (key === "color" ? frames.color.length : frames.gemini.length);

  const signed = (n: number, digits: number) => `${n < 0 ? "−" : "+"} ${Math.abs(n).toFixed(digits)}`;
  const predictedFinalSpeed = (r: NonNullable<typeof color>): Measured => ({
    value: r.motion.v0.value + theory.value * r.motion.duration,
    u: Math.hypot(r.motion.v0.u, theory.u * r.motion.duration),
  });
  // Promedio de μ de las corridas en plano ya guardadas, por método.
  const flatFriction = (key: "color" | "gemini") => {
    const label = METHODS.find((m) => m.key === key)!.label;
    const values = savedRuns.filter((e) => e.thetaDeg === 0 && e.method === label).map((e) => e.mu);
    const n = values.length;
    if (n === 0) return "—";
    const mean = values.reduce((sum, v) => sum + v, 0) / n;
    if (n === 1) return `${mean.toFixed(4)} (n = 1)`;
    const sd = Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1));
    return `${mean.toFixed(4)} ± ${(sd / Math.sqrt(n)).toFixed(4)} (n = ${n})`;
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
              <p>x(τ) = {r.motion.x0.toFixed(3)} {signed(r.motion.v0.value, 3)}·τ {signed(r.acceleration.value / 2, 3)}·τ²</p>
              <p>v(τ) = {r.motion.v0.value.toFixed(3)} {signed(r.acceleration.value, 3)}·τ</p>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-ink-2">
        x en metros y τ = t − t₀ en segundos, con t₀ el inicio del tramo analizado. Los coeficientes salen del ajuste por mínimos cuadrados: el de τ² es a/2.
      </p>
      {table(
        <>
          {row("Velocidad inicial v₀ (m/s)", (k) => metric(k, (r) => withU(r.motion.v0, 3)))}
          {row("Velocidad final v_f (m/s)", (k) => metric(k, (r) => withU(r.motion.vf, 3)))}
          {row("v_f que predice el modelo (m/s)", (k) => metric(k, (r) => withU(predictedFinalSpeed(r), 3)))}
          {row("Distancia en el tramo (m)", (k) => metric(k, (r) => r.motion.distance.toFixed(3)))}
          {row("Duración del tramo (s)", (k) => metric(k, (r) => r.motion.duration.toFixed(2)))}
        </>,
      )}
      <p className="text-xs text-ink-2">La v_f del modelo es v₀ medida + a teórica · duración; así se ve cuánto se aleja la realidad de la predicción.</p>
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
          ? "En plano, μ sale de la desaceleración: μ = |a|·(1 + I/MR²) / g. Para usarlo en las corridas en rampa, copia en la pestaña Carrito el promedio de varias corridas guardadas (el ± del promedio es el error de la media)."
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
            <div role="tablist" aria-label="Gráfica" className="mb-3 inline-flex rounded-md border border-line p-0.5">
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
        {frictionCard}
        </div>
      </div>
    </section>
  );
}
