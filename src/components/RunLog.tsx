"use client";

import type { RunEntry } from "@/lib/runStore";

const COLUMNS: [keyof RunEntry, string][] = [
  ["savedAt", "fecha"], ["video", "video"], ["thetaDeg", "theta_grados"], ["method", "metodo"],
  ["a", "a_m_s2"], ["uA", "u_a_m_s2"], ["aTheory", "a_teorica_m_s2"], ["uTheory", "u_a_teorica_m_s2"],
  ["diffPct", "diferencia_pct"], ["sigmas", "discrepancia_sigmas"], ["mu", "mu"], ["uMu", "u_mu"],
  ["r2", "r2"], ["frames", "fotogramas"], ["msPerFrame", "ms_por_fotograma"],
  ["manualRmseMm", "rmse_manual_mm"], ["manualOffsetMm", "desfase_fijo_mm"], ["manualRmseNoOffsetMm", "variacion_mm"],
];

function toCsv(entries: RunEntry[]) {
  const cell = (value: RunEntry[keyof RunEntry]) => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [COLUMNS.map(([, header]) => header).join(","), ...entries.map((entry) => COLUMNS.map(([key]) => cell(entry[key])).join(","))].join("\n");
}

// Repeticiones del mismo ángulo y método: promedio, desviación estándar y error estándar de la media.
function summarize(entries: RunEntry[]) {
  const groups = new Map<string, RunEntry[]>();
  for (const entry of entries) {
    const key = `${entry.thetaDeg}|${entry.method}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return [...groups.values()]
    .map((group) => {
      const n = group.length;
      const mean = group.reduce((sum, e) => sum + e.a, 0) / n;
      const sd = n > 1 ? Math.sqrt(group.reduce((sum, e) => sum + (e.a - mean) ** 2, 0) / (n - 1)) : null;
      const theory = group.reduce((sum, e) => sum + e.aTheory, 0) / n;
      return { thetaDeg: group[0].thetaDeg, method: group[0].method, n, mean, sd, sem: sd === null ? null : sd / Math.sqrt(n), theory };
    })
    .sort((a, b) => a.thetaDeg - b.thetaDeg || a.method.localeCompare(b.method));
}

const fixed = (value: number | null, digits: number) => (value === null ? "—" : value.toFixed(digits));

export function RunLog({ entries, onRemove, onClear }: { entries: RunEntry[]; onRemove: (id: string) => void; onClear: () => void }) {
  if (entries.length === 0) return null;
  const summary = summarize(entries);

  const download = () => {
    const url = URL.createObjectURL(new Blob([toCsv(entries)], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "corridas-carrito.csv";
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="space-y-3 rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Corridas guardadas ({entries.length})</h2>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn" onClick={download}>Descargar corridas (CSV)</button>
          <button type="button" className="btn" onClick={() => { if (window.confirm("¿Borrar todas las corridas guardadas?")) onClear(); }}>Borrar todas</button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <h3 className="mb-1.5 text-xs font-medium text-ink-2">Resumen por ángulo y método (la desviación estándar necesita al menos dos repeticiones)</h3>
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="text-left">
              {["θ (°)", "Método", "n", "a promedio (m/s²)", "Desv. estándar", "Error de la media", "a teórica (m/s²)"].map((h) => (
                <th key={h} scope="col" className="pb-1.5 pr-3 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <tr key={`${s.thetaDeg}|${s.method}`} className="border-t border-line font-mono tabular-nums">
                <td className="py-1.5 pr-3">{s.thetaDeg}</td>
                <td className="py-1.5 pr-3 font-sans">{s.method}</td>
                <td className="py-1.5 pr-3">{s.n}</td>
                <td className="py-1.5 pr-3">{s.mean.toFixed(3)}</td>
                <td className="py-1.5 pr-3">{fixed(s.sd, 3)}</td>
                <td className="py-1.5 pr-3">{fixed(s.sem, 3)}</td>
                <td className="py-1.5 pr-3">{s.theory.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="overflow-x-auto">
        <summary className="cursor-pointer text-xs font-medium text-ink-2 hover:text-foreground">Ver cada corrida ({entries.length})</summary>
        <table className="mt-2 w-full min-w-[52rem] text-sm">
          <thead>
            <tr className="text-left">
              {["Video", "θ (°)", "Método", "a medida (m/s²)", "a teórica (m/s²)", "Diferencia", "Discrepancia", "RMSE manual", ""].map((h) => (
                <th key={h} scope="col" className="pb-1.5 pr-3 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id} className="border-t border-line font-mono tabular-nums">
                <td className="max-w-40 truncate py-1.5 pr-3 font-sans" title={e.video}>{e.video}</td>
                <td className="py-1.5 pr-3">{e.thetaDeg}</td>
                <td className="py-1.5 pr-3 font-sans">{e.method}</td>
                <td className="py-1.5 pr-3">{e.a.toFixed(3)} ± {e.uA.toFixed(3)}</td>
                <td className="py-1.5 pr-3">{e.aTheory.toFixed(3)} ± {e.uTheory.toFixed(3)}</td>
                <td className="py-1.5 pr-3">{e.diffPct === null ? "—" : `${e.diffPct.toFixed(1)} %`}</td>
                <td className="py-1.5 pr-3">{e.sigmas === null ? "—" : `${e.sigmas.toFixed(1)} σ`}</td>
                <td className="py-1.5 pr-3">{e.manualRmseMm === null ? "—" : `${e.manualRmseMm.toFixed(1)} mm`}</td>
                <td className="py-1.5">
                  <button type="button" className="text-xs text-ink-2 underline" onClick={() => onRemove(e.id)}>Quitar</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
