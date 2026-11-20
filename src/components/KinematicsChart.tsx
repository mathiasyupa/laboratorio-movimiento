"use client";

import { useEffect, useRef } from "react";
import {
  Chart,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  ScatterController,
  Tooltip,
} from "chart.js";
import type { Point } from "@/lib/physics";

Chart.register(ScatterController, LinearScale, PointElement, LineElement, Tooltip, Legend);

export type ChartSeries = {
  label: string;
  colorVar: string;
  points: Point[];
  style: "points" | "line" | "dashed";
};

type Props = { title: string; hint: string; yLabel: string; unit: string; series: ChartSeries[] };

const LEGEND_SYMBOL = { points: "circle", line: "line", dashed: "dash" } as const;

export function KinematicsChart({ title, hint, yLabel, unit, series }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const css = getComputedStyle(canvas);
    const token = (name: string) => css.getPropertyValue(name).trim();
    const axis = (text: string) => ({
      type: "linear" as const,
      title: { display: true, text, color: token("--foreground"), font: { size: 13, weight: 600 } },
      ticks: { color: token("--ink-2"), font: { size: 12 } },
      grid: { color: token("--grid") },
      border: { color: token("--line") },
    });

    const chart = new Chart(canvas, {
      type: "scatter",
      data: {
        datasets: series.map((s) => ({
          label: s.label,
          data: s.points,
          showLine: s.style !== "points",
          borderColor: token(s.colorVar),
          backgroundColor: token(s.colorVar),
          borderWidth: s.style === "points" ? 1 : 3,
          borderDash: s.style === "dashed" ? [8, 5] : [],
          pointStyle: LEGEND_SYMBOL[s.style],
          // La leyenda dibuja las líneas con este color, así que solo los puntos llevan el borde claro.
          pointBorderColor: s.style === "points" ? token("--surface") : token(s.colorVar),
          pointRadius: s.style === "points" ? 5 : 0,
          pointHoverRadius: s.style === "points" ? 7 : 0,
          order: s.style === "points" ? 1 : 0,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        scales: { x: axis("Tiempo (s)"), y: axis(yLabel) },
        plugins: {
          legend: {
            position: "top",
            align: "start",
            labels: {
              color: token("--foreground"),
              font: { size: 12 },
              usePointStyle: true,
              boxHeight: 14,
              padding: 12,
              sort: (a, b) => (a.datasetIndex ?? 0) - (b.datasetIndex ?? 0),
            },
          },
          tooltip: {
            titleFont: { size: 14 },
            bodyFont: { size: 14 },
            callbacks: {
              label: (item) =>
                `${item.dataset.label}: ${(item.parsed.y ?? 0).toFixed(3)} ${unit} en t = ${(item.parsed.x ?? 0).toFixed(3)} s`,
            },
          },
        },
      },
    });
    return () => chart.destroy();
  }, [series, unit, yLabel]);

  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-xs text-ink-2">{hint}</figcaption>
      <div className="relative h-72 w-full sm:h-80">
        <canvas ref={canvasRef} aria-label={`${title}. ${hint}`} role="img" />
      </div>
    </figure>
  );
}
