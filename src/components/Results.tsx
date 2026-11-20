"use client";

import { useMemo, useState } from "react";
import {
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
const COMPATIBLE_SIGMAS = 2;

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
  return {
    times,
    positions,
    fit,
    acceleration,
    local: localDerivatives(times, positions),
    resistance: resistanceFromAcceleration(acceleration, run.model),
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

type Props = { run: RawRun; marks: Detection[]; onSave: (entries: RunEntry[]) => void };

export function Results({ run, marks, onSave }: Props) {
  const [savedMarks, setSavedMarks] = useState<Detection[] | null>(null);
  const [chart, setChart] = useState<"position" | "velocity" | "acceleration">("position");
  const tracking = useMemo(
    () => ({
      color: trackingError(run.colorDetections, marks, run.metersPerPixel),
      gemini: trackingError(run.geminiDetections, marks, run.metersPerPixel),
    }),
    [run, marks],
  );
  const color = useMemo(() => analyzeMethod(run.colorDetections, run), [run]);
  const gemini = useMemo(() => analyzeMethod(run.geminiDetections, run), [run]);
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
    return { position, velocity, acceleration };
  }, [color, gemini, theory]);

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
    return { rmse, sigmas: discrepancy(color.acceleration, gemini.acceleration) };
  }, [color, gemini]);

  const visibleMethods = METHODS.filter((method) => (method.key === "color" ? run.usedColor : run.usedGemini));
  const msPerFrame = (key: "color" | "gemini") => {
    const count = key === "color" ? run.totalSamples : run.geminiRequested;
    return count > 0 ? (key === "color" ? run.colorMs : run.geminiMs) / count : null;
  };
  const differencePct = (a: Measured) => (theory.value === 0 ? null : ((a.value - theory.value) / Math.abs(theory.value)) * 100);
  const noOffsetError = (key: "color" | "gemini") => {
    const error = tracking[key];
    // Con muy pocos fotogramas, quitar el desfase deja un error artificialmente cercano a cero.
    return error && error.count >= MIN_FRAMES_WITHOUT_OFFSET ? error.rmseNoOffsetMeters * 1000 : null;
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
        method: method.label,
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
      }];
    });
    onSave(entries);
    setSavedMarks(marks);
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
  const saved = savedMarks === marks;

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
  const chartTabs = [
    { id: "position", label: "Posición" },
    { id: "velocity", label: "Velocidad" },
    { id: "acceleration", label: "Aceleración" },
  ] as const;

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
          {table(
            <>
              {row("Aceleración medida (m/s²)", (k) => metric(k, (r) => withU(r.acceleration, 3)))}
              {row("Diferencia con la teoría", (k) => metric(k, (r) => {
                const pct = differencePct(r.acceleration);
                return pct === null ? "—" : `${pct.toFixed(1)} %`;
              }))}
              {row("Discrepancia", (k) => metric(k, (r) => sigmaText(discrepancy(r.acceleration, theory))))}
              {row(isFlat ? "μ medido en plano" : "μ que explicaría la medición", (k) => metric(k, (r) => withU(r.resistance, 4)))}
              {marks.length > 0 && (
                <>
                  {row("Error vs. marcado manual (mm)", (k) => (tracking[k] ? (tracking[k].rmseMeters * 1000).toFixed(1) : "—"))}
                  {row("Sin el desfase fijo (mm)", (k) => noOffsetError(k)?.toFixed(1) ?? "—")}
                </>
              )}
            </>,
          )}
          <details className="group text-sm">
            <summary className="cursor-pointer text-xs font-medium text-ink-2 hover:text-foreground">Más detalles del ajuste y de los tiempos</summary>
            <div className="mt-3 space-y-3">
              {table(
                <>
                  {row("R² del ajuste cuadrático", (k) => metric(k, (r) => r.fit.r2.toFixed(4)))}
                  {row("Residuo del ajuste (mm)", (k) => metric(k, (r) => (r.fit.rmse * 1000).toFixed(2)))}
                  {row("Fotogramas detectados", (k) => (k === "color" ? `${run.colorDetections.length} de ${run.totalSamples}` : `${run.geminiDetections.length} de ${run.geminiRequested}`))}
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
                {marks.length > 0 && run.usedColor && run.usedGemini && " El desfase fijo aparece porque Gemini da el centro de la caja del carrito, no la marca de color."}
                {` Extraer los fotogramas tomó ${run.extractionMs.toFixed(0)} ms, fuera del tiempo de los métodos.`}
                {betweenMethods &&
                  ` Entre métodos: ${(betweenMethods.rmse * 1000).toFixed(1)} mm de RMSE en posición, sin el desfase fijo, y ${sigmaText(betweenMethods.sigmas)} en aceleración.`}
              </p>
            </div>
          </details>
          {marks.length === 0 && <p className="text-xs text-ink-2">Para guardar el error de seguimiento, marca fotogramas a mano antes de guardar la corrida.</p>}
        </div>

        {charts.position.length > 0 && (
          <div className="min-w-0 rounded-lg border border-line bg-surface p-4">
            <div role="tablist" aria-label="Gráfica" className="mb-3 inline-flex rounded-md border border-line p-0.5">
              {chartTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={chart === tab.id}
                  onClick={() => setChart(tab.id)}
                  className={`rounded px-3 py-1 text-xs font-medium ${chart === tab.id ? "bg-[var(--series-1)] text-white" : "text-ink-2 hover:text-foreground"}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            {chart === "position" && (
              <KinematicsChart
                title="Posición sobre la rampa"
                hint="Puntos: posición medida en cada fotograma. Línea: parábola ajustada."
                yLabel="Posición (m)"
                unit="m"
                series={charts.position}
              />
            )}
            {chart === "velocity" && (
              <KinematicsChart
                title="Velocidad"
                hint="Puntos: calculados con posiciones vecinas. Línea: derivada del ajuste; recta si la aceleración es constante."
                yLabel="Velocidad (m/s)"
                unit="m/s"
                series={charts.velocity}
              />
            )}
            {chart === "acceleration" && (
              <KinematicsChart
                title="Aceleración"
                hint="Puntos: calculados con posiciones vecinas. Línea continua: ajuste. Punteada: teoría con rotación y resistencia."
                yLabel="Aceleración (m/s²)"
                unit="m/s²"
                series={charts.acceleration}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}
