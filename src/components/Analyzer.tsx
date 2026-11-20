"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { averageHsv, detectColor, type Hsv } from "@/lib/colorDetect";
import { refineRuler } from "@/lib/rulerRefine";
import { fitQuadratic, toRampAxis, wheelInertiaRatio, type Box, type CartModel, type Detection, type Point } from "@/lib/physics";
import { frameSamples, frameSeekTime, resolveDuration, seekTo } from "@/lib/video";
import { Results, type RawRun } from "./Results";
import { getRuns, getServerRuns, setRuns, subscribeRuns } from "@/lib/runStore";
import { RunLog } from "./RunLog";

const MAX_WORK_WIDTH = 960;
const CLICK_UNCERTAINTY_PX = 2;
// Sin el ajuste fino, la IA erró la escala hasta en 8.5 % en pruebas; ajustada quedó dentro de 0.15 %, como un clic.
const COARSE_RULER_UNCERTAINTY_PX = 25;

type RulerSource = "none" | "detecting" | "ai" | "manual" | "failed";

const RULER_STATUS: Record<RulerSource, string> = {
  none: "Sin regla",
  detecting: "Buscando con IA…",
  ai: "Detectada por IA",
  manual: "Marcada a mano",
  failed: "No encontrada",
};
const BUSY_WAIT_MS = 10_000;
const BUSY_RETRIES = 6;
const GEMINI_BATCH_FRAMES = 20;
const GEMINI_BATCH_CHARS = 3_500_000;
const MAX_MANUAL_FRAMES = 20;
const MIN_FRAMES_FOR_FIT = 4;

// El linter de React toma los manejadores async como código de render y rechaza performance.now() directo.
const clock = () => performance.now();

// Factor k de I = k·m·r² para cada rueda.
const WHEEL_SHAPES = [
  { value: "0.5", label: "Disco (k = ½)" },
  { value: "1", label: "Aro (k = 1)" },
];


type Tool = "none" | "ruler" | "color";
type Method = "both" | "gemini" | "color";
type Panel = "video" | "calibracion" | "experimento" | "carrito";

const METHOD_OPTIONS: { value: Method; label: string; detail: string }[] = [
  { value: "both", label: "Ambos", detail: "Compara IA y color. Necesita la marca de color." },
  { value: "gemini", label: "Solo IA", detail: "No necesita marca de color. Usa internet y cuota de Gemini." },
  { value: "color", label: "Solo color", detail: "Rápido y sin internet. Necesita la marca de color." },
];

// Inclinación de la regla respecto de la horizontal de la imagen, entre 0° y 90°.
function rulerInclination([p0, p1]: Point[]) {
  return (Math.atan2(Math.abs(p1.y - p0.y), Math.abs(p1.x - p0.x)) * 180) / Math.PI;
}

// "plano inclinado" contiene "plano" pero describe una rampa.
function describesFlatSurface(text: string) {
  if (/inclinad|rampa|\bno\s+(es\s+|est[aá]\s+)?(plan|horizontal)/i.test(text)) return false;
  return /\b(plan[ao]s?|horizontal(es)?)\b/i.test(text);
}

function splitIntoBatches<T extends { image: string }>(frames: T[]) {
  const batches: T[][] = [];
  let chars = 0;
  for (const frame of frames) {
    const last = batches[batches.length - 1];
    if (!last || last.length >= GEMINI_BATCH_FRAMES || chars + frame.image.length > GEMINI_BATCH_CHARS) {
      batches.push([frame]);
      chars = frame.image.length;
    } else {
      last.push(frame);
      chars += frame.image.length;
    }
  }
  return batches;
}

async function postWithRetry(url: string, payload: object) {
  let waitedMs = 0;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    // Un 429 por cuota diaria no se resuelve esperando segundos, a diferencia del límite por minuto.
    const canRetry = response.status === 503 || (response.status === 429 && !/per day/i.test(data.error ?? ""));
    if (canRetry && attempt < BUSY_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
      waitedMs += BUSY_WAIT_MS;
      continue;
    }
    if (!response.ok) throw new Error(data.error ?? `Error ${response.status}`);
    return { data, waitedMs };
  }
}

async function requestGemini(images: string[], description: string) {
  const { data, waitedMs } = await postWithRetry("/api/detect-gemini", { images, description });
  return { detections: data.detections as { index: number; x: number; y: number; box: Box }[], waitedMs };
}

export function Analyzer() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const sourceUrlRef = useRef<string | null>(null);

  const [loaded, setLoaded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [tool, setTool] = useState<Tool>("none");
  const [ruler, setRuler] = useState<Point[]>([]);
  const [rulerMeters, setRulerMeters] = useState("0.50");
  const [rulerUncertaintyMm, setRulerUncertaintyMm] = useState("1");
  const [rulerSource, setRulerSource] = useState<RulerSource>("none");
  const [rulerError, setRulerError] = useState("");
  const [rulerRefined, setRulerRefined] = useState(false);
  const rulerRequestRef = useRef(0);
  const [panel, setPanel] = useState<Panel>("video");
  const [videoName, setVideoName] = useState("");
  const [fps, setFps] = useState("60");
  const [uThetaDeg, setUThetaDeg] = useState("0.5");
  const [totalMassG, setTotalMassG] = useState("");
  const [wheelCount, setWheelCount] = useState("4");
  const [wheelMassG, setWheelMassG] = useState("");
  const [wheelShape, setWheelShape] = useState("0.5");
  const [mu, setMu] = useState("0");
  const [uMu, setUMu] = useState("0");
  const savedRuns = useSyncExternalStore(subscribeRuns, getRuns, getServerRuns);
  const [targetColor, setTargetColor] = useState<Hsv | null>(null);
  const [hueTolerance, setHueTolerance] = useState(15);
  const [thetaDeg, setThetaDeg] = useState("15");
  const [gravity, setGravity] = useState("9.81");
  const [samplesPerSecond, setSamplesPerSecond] = useState("30");
  const [method, setMethod] = useState<Method>("both");
  const usesColor = method !== "gemini";
  const usesGemini = method !== "color";
  const [geminiMaxFrames, setGeminiMaxFrames] = useState("20");
  const [description, setDescription] = useState("carrito con ruedas sobre una rampa");
  const [angleBeforeFlat, setAngleBeforeFlat] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState("");
  const [run, setRun] = useState<RawRun | null>(null);
  const [marking, setMarking] = useState<{ times: number[]; index: number } | null>(null);
  const [marks, setMarks] = useState<Detection[]>([]);
  const [frameVersion, setFrameVersion] = useState(0);
  const markFrameSeekingRef = useRef(false);
  const isMarking = marking !== null;
  const locked = busy || isMarking;

  // Velocidad del ajuste de Gemini, para mostrarla junto a su caja.
  const geminiVelocity = useMemo(() => {
    if (!run) return null;
    const detections = run.geminiDetections;
    const fit = fitQuadratic(detections.map((d) => d.t), toRampAxis(detections, run.ruler, run.metersPerPixel));
    return fit ? fit.velocityAt : null;
  }, [run]);

  const drawFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    if (!video || !canvas || !ctx || video.videoWidth === 0) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Durante el marcado manual no se muestra la detección, para no influir en los clics.
    if (usesColor && targetColor && !isMarking) {
      const found = detectColor(ctx.getImageData(0, 0, canvas.width, canvas.height), targetColor, hueTolerance);
      if (found) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(found.x, found.y, 12, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "#2a78d6";
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    // Gemini solo analiza algunos fotogramas: se muestra el más cercano al momento actual.
    const nearest = isMarking
      ? undefined
      : run?.geminiDetections.reduce<Detection | undefined>(
          (best, d) => (!best || Math.abs(d.t - video.currentTime) < Math.abs(best.t - video.currentTime) ? d : best),
          undefined,
        );
    if (nearest?.box) {
      const { xmin, ymin, xmax, ymax } = nearest.box;
      ctx.lineWidth = 6;
      ctx.strokeStyle = "#ffffff";
      ctx.strokeRect(xmin, ymin, xmax - xmin, ymax - ymin);
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#eb6834";
      ctx.strokeRect(xmin, ymin, xmax - xmin, ymax - ymin);
      const velocity = geminiVelocity ? ` · v = ${geminiVelocity(nearest.t).toFixed(2)} m/s` : "";
      const label = `Gemini · t = ${nearest.t.toFixed(2)} s${velocity}`;
      ctx.font = "600 15px sans-serif";
      const labelWidth = ctx.measureText(label).width + 12;
      const labelY = Math.max(ymin - 24, 0);
      const labelX = Math.min(Math.max(xmin, 0), canvas.width - labelWidth);
      ctx.fillStyle = "#b8461c";
      ctx.fillRect(labelX, labelY, labelWidth, 24);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(label, labelX + 6, labelY + 17);
    }

    if (ruler.length > 0) {
      ctx.strokeStyle = "#eda100";
      ctx.fillStyle = "#eda100";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ruler.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
      ruler.forEach((p) => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
      });
      if (ruler.length === 2) {
        const [p0, p1] = ruler;
        const label = `${rulerMeters} m · ${rulerInclination(ruler).toFixed(1)}°`;
        ctx.font = "600 14px sans-serif";
        const width = ctx.measureText(label).width + 12;
        const x = Math.min(Math.max((p0.x + p1.x) / 2 - width / 2, 0), canvas.width - width);
        const y = Math.max(Math.min(p0.y, p1.y) - 30, 0);
        ctx.fillStyle = "#7a5200";
        ctx.fillRect(x, y, width, 22);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, x + 6, y + 16);
      }
    }
  }, [ruler, targetColor, hueTolerance, isMarking, usesColor, run, rulerMeters, geminiVelocity]);

  useEffect(() => {
    if (!busy) drawFrame();
  }, [drawFrame, busy, loaded, frameVersion]);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    };
  }, []);

  const loadVideo = async (blob: Blob, name: string) => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    setVideoName(name);
    setMessage("");
    setRun(null);
    setMarks([]);
    setMarking(null);
    setLoaded(false);
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    const url = URL.createObjectURL(blob);
    sourceUrlRef.current = url;

    try {
      await new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("decode"));
        video.src = url;
      });
    } catch {
      setMessage("El navegador no pudo abrir ese video. Prueba con un MP4 (H.264) o WebM.");
      return;
    }

    const total = await resolveDuration(video);
    const width = Math.min(video.videoWidth, MAX_WORK_WIDTH);
    const height = Math.round((video.videoHeight * width) / video.videoWidth);
    const sameSize = canvas.width === width && canvas.height === height;
    canvas.width = width;
    canvas.height = height;
    await seekTo(video, 0);
    setDuration(total);
    setCurrentTime(0);
    setStartTime(0);
    setEndTime(total);
    setLoaded(true);
    // Con la cámara fija, una regla marcada a mano sirve para las siguientes repeticiones.
    if (!(sameSize && rulerSource === "manual" && ruler.length === 2)) void detectRuler();
  };

  const detectRuler = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    if (!video || !canvas || !ctx || video.videoWidth === 0) return;
    const request = ++rulerRequestRef.current;
    setTool("none");
    setRuler([]);
    setRulerError("");
    setRulerSource("detecting");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // Se guarda antes de esperar a la IA: mientras tanto el canvas se redibuja con marcas encima.
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const image = canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    try {
      const { data } = await postWithRetry("/api/detect-ruler", { image });
      // Si mientras tanto se cargó otro video o se marcó a mano, esta respuesta ya no aplica.
      if (request !== rulerRequestRef.current) return;
      if (!data.found) {
        setRulerSource("failed");
        return;
      }
      const coarse: [Point, Point] = [
        { x: data.start.x * canvas.width, y: data.start.y * canvas.height },
        { x: data.end.x * canvas.width, y: data.end.y * canvas.height },
      ];
      const refined = refineRuler(frame, coarse);
      setRuler(refined ?? coarse);
      setRulerRefined(refined !== null);
      setRulerSource("ai");
    } catch (error) {
      if (request !== rulerRequestRef.current) return;
      setRulerError((error as Error).message);
      setRulerSource("failed");
    }
  };

  const startManualRuler = () => {
    rulerRequestRef.current++;
    setRuler([]);
    setRulerSource("manual");
    setTool("ruler");
  };

  const startCamera = async () => {
    setMessage("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, frameRate: { ideal: 60 } },
        audio: false,
      });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setRecording(false);
        void loadVideo(new Blob(chunks, { type: recorder.mimeType }), `Grabación ${new Date().toLocaleTimeString()}`);
      };
      recorderRef.current = recorder;
      setRecording(true);
      recorder.start();
      requestAnimationFrame(() => {
        if (previewRef.current) previewRef.current.srcObject = stream;
      });
    } catch {
      setMessage("No se pudo abrir la cámara. Revisa el permiso del navegador; fuera de localhost la página debe estar en HTTPS.");
    }
  };

  const scrub = async (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    setCurrentTime(time);
    await seekTo(video, time);
    drawFrame();
  };

  const showMarkFrame = async (times: number[], index: number) => {
    const video = videoRef.current;
    if (!video) return;
    markFrameSeekingRef.current = true;
    if (index >= times.length) {
      setMarking(null);
      await seekTo(video, currentTime);
    } else {
      setMarking({ times, index });
      await seekTo(video, run ? frameSeekTime(times[index], run.fps) : times[index]);
    }
    markFrameSeekingRef.current = false;
    setFrameVersion((version) => version + 1);
  };

  // Se prefieren los fotogramas de Gemini porque el método por color también tiene detección en ellos.
  const markSource = run && run.geminiDetections.length >= MIN_FRAMES_FOR_FIT ? run.geminiDetections : (run?.colorDetections ?? []);

  const startMarking = () => {
    const source = markSource;
    const step = Math.ceil(source.length / MAX_MANUAL_FRAMES);
    setMarks([]);
    void showMarkFrame(source.filter((_, i) => i % step === 0).map((d) => d.t), 0);
  };

  const undoMark = () => {
    if (!marking || marking.index === 0) return;
    const previous = marking.index - 1;
    setMarks((current) => current.filter((mark) => mark.t !== marking.times[previous]));
    void showMarkFrame(marking.times, previous);
  };

  const changeDescription = (text: string) => {
    const wasFlat = describesFlatSurface(description);
    const isFlat = describesFlatSurface(text);
    setDescription(text);
    if (isFlat && !wasFlat) {
      setAngleBeforeFlat(thetaDeg);
      setThetaDeg("0");
    } else if (!isFlat && wasFlat && angleBeforeFlat !== null) {
      setThetaDeg(angleBeforeFlat);
      setAngleBeforeFlat(null);
    }
  };

  const onCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d", { willReadFrequently: true });
    const video = videoRef.current;
    if (!canvas || !ctx || !video || (tool === "none" && !marking)) return;
    const rect = canvas.getBoundingClientRect();
    const point = {
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
    if (marking) {
      if (markFrameSeekingRef.current) return;
      setMarks((current) => [...current, { t: marking.times[marking.index], ...point }]);
      void showMarkFrame(marking.times, marking.index + 1);
    } else if (tool === "ruler") {
      const next = ruler.length >= 2 ? [point] : [...ruler, point];
      setRuler(next);
      if (next.length === 2) setTool("none");
    } else {
      // Se lee del video sin las marcas dibujadas encima.
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      setTargetColor(averageHsv(ctx.getImageData(0, 0, canvas.width, canvas.height), point));
      setTool("none");
    }
  };

  const rulerPixels = ruler.length === 2 ? Math.hypot(ruler[1].x - ruler[0].x, ruler[1].y - ruler[0].y) : 0;
  const meters = Number(rulerMeters);
  const theta = Number(thetaDeg);
  const g = Number(gravity);
  const rate = Number(samplesPerSecond);
  const videoFps = Number(fps);
  const effectiveRate = videoFps > 0 && rate > 0 ? videoFps / Math.max(1, Math.round(videoFps / rate)) : 0;
  const totalMass = Number(totalMassG);
  const wheels = Number(wheelCount);
  const wheelMass = Number(wheelMassG);
  // Sin masas de ruedas el modelo ignora la rotación, que es el caso de un carrito que desliza.
  const usesRotation = wheelMassG.trim() !== "" && wheelMass > 0;
  const inertiaRatio = usesRotation && totalMass > 0 && wheels > 0 ? wheelInertiaRatio(totalMass, wheels, wheelMass, Number(wheelShape)) : 0;
  const numericInputsValid = [uThetaDeg, mu, uMu, rulerUncertaintyMm].every((value) => value.trim() !== "" && Number(value) >= 0);

  const blockers = [
    !loaded && "carga un video",
    rulerPixels === 0 && (rulerSource === "detecting" ? "espera a que la IA encuentre la regla" : "marca la regla a mano"),
    !(meters > 0) && "indica el largo de la regla",
    usesColor && !targetColor && "elige el color de la marca",
    usesGemini && !(Number(geminiMaxFrames) >= MIN_FRAMES_FOR_FIT) && `indica al menos ${MIN_FRAMES_FOR_FIT} fotogramas para Gemini`,
    !(endTime > startTime) && "define un tramo válido",
    !(theta >= 0 && theta < 90) && "indica un ángulo desde 0° hasta menos de 90°",
    !(g > 0) && "indica g",
    !(rate > 0) && "indica las muestras por segundo",
    !(videoFps > 0) && "indica los fps del video",
    !numericInputsValid && "revisa que las incertidumbres y μ no estén vacías ni sean negativas",
    usesRotation && !(totalMass > 0) && "indica la masa total del carrito",
    usesRotation && !(Number.isInteger(wheels) && wheels > 0) && "indica cuántas ruedas tiene",
    usesRotation && totalMass > 0 && wheels * wheelMass >= totalMass && "la masa de las ruedas debe ser menor que la masa total",
  ].filter(Boolean) as string[];

  const analyze = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || blockers.length > 0) return;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;

    setBusy(true);
    setRun(null);
    setMarks([]);
    setMessage("");
    const samples = frameSamples(startTime, endTime, videoFps, rate);
    const geminiStep = usesGemini ? Math.max(1, Math.ceil(samples.length / Number(geminiMaxFrames))) : 0;
    const colorDetections: Detection[] = [];
    const geminiQueue: { t: number; image: string }[] = [];
    let colorMs = 0;
    let extractionMs = 0;

    for (let i = 0; i < samples.length; i++) {
      const sendToGemini = geminiStep > 0 && i % geminiStep === 0;
      if (!usesColor && !sendToGemini) continue;

      setProgress(`Preparando fotograma ${i + 1} de ${samples.length}`);
      const extractionStart = clock();
      await seekTo(video, samples[i].seekTime);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      extractionMs += clock() - extractionStart;

      if (usesColor && targetColor) {
        const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const detectStart = clock();
        const found = detectColor(frame, targetColor, hueTolerance);
        colorMs += clock() - detectStart;
        if (found) colorDetections.push({ t: samples[i].t, ...found });
      }
      if (sendToGemini) {
        geminiQueue.push({ t: samples[i].t, image: canvas.toDataURL("image/jpeg", 0.85).split(",")[1] });
      }
    }

    const geminiDetections: Detection[] = [];
    let geminiMs = 0;
    const batches = splitIntoBatches(geminiQueue);
    for (let i = 0; i < batches.length; i++) {
      setProgress(`IA: enviando ${batches[i].length} fotogramas (lote ${i + 1} de ${batches.length})`);
      const requestStart = clock();
      try {
        const result = await requestGemini(batches[i].map((frame) => frame.image), description);
        // Las pausas por sobrecarga no son tiempo de procesamiento del método.
        geminiMs += clock() - requestStart - result.waitedMs;
        for (const detection of result.detections) {
          geminiDetections.push({
            t: batches[i][detection.index].t,
            x: detection.x * canvas.width,
            y: detection.y * canvas.height,
            box: {
              xmin: detection.box.xmin * canvas.width,
              ymin: detection.box.ymin * canvas.height,
              xmax: detection.box.xmax * canvas.width,
              ymax: detection.box.ymax * canvas.height,
            },
          });
        }
      } catch (error) {
        setMessage(`Gemini falló en el lote ${i + 1}: ${(error as Error).message}. Se muestran los resultados obtenidos hasta ahí.`);
        break;
      }
    }
    geminiDetections.sort((a, b) => a.t - b.t);

    if (colorDetections.length < MIN_FRAMES_FOR_FIT && geminiDetections.length < MIN_FRAMES_FOR_FIT) {
      setMessage((current) => current || "Muy pocas detecciones para ajustar. Revisa el color elegido, la tolerancia y el tramo.");
    }

    const model: CartModel = {
      thetaDeg: theta,
      uThetaDeg: Number(uThetaDeg),
      g,
      mu: Number(mu),
      uMu: Number(uMu),
      inertiaRatio,
    };
    setRun({
      colorDetections,
      geminiDetections,
      totalSamples: samples.length,
      geminiRequested: geminiQueue.length,
      colorMs,
      geminiMs,
      extractionMs,
      usedColor: usesColor,
      usedGemini: usesGemini,
      ruler: ruler as [Point, Point],
      metersPerPixel: meters / rulerPixels,
      calibrationRelativeUncertainty: Math.hypot((Math.SQRT2 * (rulerSource === "ai" && !rulerRefined ? COARSE_RULER_UNCERTAINTY_PX : CLICK_UNCERTAINTY_PX)) / rulerPixels, Number(rulerUncertaintyMm) / 1000 / meters),
      fps: videoFps,
      video: videoName,
      model,
    });
    setProgress("");
    await seekTo(video, currentTime);
    setBusy(false);
  };

  const rulerAngle = ruler.length === 2 ? rulerInclination(ruler) : null;
  const tabs: { id: Panel; label: string; ready: boolean }[] = [
    { id: "video", label: "Video", ready: loaded && (!usesGemini || Number(geminiMaxFrames) >= MIN_FRAMES_FOR_FIT) },
    { id: "calibracion", label: "Calibración", ready: rulerPixels > 0 && meters > 0 && (!usesColor || targetColor !== null) },
    { id: "experimento", label: "Experimento", ready: theta >= 0 && theta < 90 && g > 0 && rate > 0 && videoFps > 0 && endTime > startTime },
    { id: "carrito", label: "Carrito", ready: numericInputsValid && (!usesRotation || (totalMass > 0 && Number.isInteger(wheels) && wheels > 0 && wheels * wheelMass < totalMass)) },
  ];

  return (
    <main className="mx-auto w-full max-w-[96rem] flex-1 space-y-4 px-4 py-4 sm:px-6">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Laboratorio de Movimiento</h1>
        <p className="text-sm text-ink-2">Posición, velocidad y aceleración de un carrito a partir de video, con IA y con seguimiento por color.</p>
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
        <section className="min-w-0 space-y-2">
          <div className="relative flex aspect-video max-h-[64vh] w-full items-center justify-center overflow-hidden rounded-lg border border-line bg-black">
            {/* El video queda fuera de vista: solo alimenta al canvas. */}
            <video ref={videoRef} muted playsInline preload="auto" className="absolute h-px w-px opacity-0" />
            <canvas
              ref={canvasRef}
              onClick={onCanvasClick}
              className={`max-h-full max-w-full ${loaded && !recording ? "" : "hidden"} ${tool === "none" && !isMarking ? "" : "cursor-crosshair"}`}
            />
            {recording && <video ref={previewRef} autoPlay muted playsInline className="h-full w-full object-contain" />}
            {!loaded && !recording && <p className="px-6 text-center text-sm text-white/70">Sube un video o graba uno con la cámara desde la pestaña Video.</p>}
          </div>

          {tool !== "none" && (
            <p role="status" className="rounded-md bg-surface px-3 py-2 text-sm font-medium">
              {tool === "ruler"
                ? `Haz clic en ${ruler.length === 1 ? "el otro extremo" : "un extremo"} de la regla sobre la imagen.`
                : "Haz clic sobre la marca de color del carrito."}
            </p>
          )}

          {marking && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-3">
              <p role="status" className="mr-auto text-sm font-medium">
                Fotograma {marking.index + 1} de {marking.times.length}: haz clic en el centro {run?.usedColor ? "de la marca de color" : "del carrito"}, siempre en el mismo punto.
              </p>
              <button type="button" className="btn" disabled={marking.index === 0} onClick={undoMark}>Deshacer</button>
              <button type="button" className="btn" onClick={() => void showMarkFrame(marking.times, marking.index + 1)}>Omitir fotograma</button>
              <button type="button" className="btn" onClick={() => void showMarkFrame(marking.times, marking.times.length)}>Terminar</button>
            </div>
          )}

          {loaded && !recording && !marking && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
              <span className="w-14 font-mono tabular-nums">{currentTime.toFixed(2)} s</span>
              <input
                type="range"
                min={0}
                max={duration}
                step={0.01}
                value={currentTime}
                disabled={busy}
                onChange={(event) => void scrub(Number(event.target.value))}
                className="min-w-40 flex-1 accent-[var(--series-1)]"
                aria-label="Tiempo del video"
              />
              <button type="button" className="btn" disabled={busy} onClick={() => setStartTime(currentTime)}>Marcar inicio</button>
              <button type="button" className="btn" disabled={busy} onClick={() => setEndTime(currentTime)}>Marcar fin</button>
              <span className="font-mono text-xs tabular-nums text-ink-2">Tramo {startTime.toFixed(2)}–{endTime.toFixed(2)} s</span>
            </div>
          )}
          {run && run.geminiDetections.length > 0 && !marking && (
            <p className="text-xs text-ink-2">La caja naranja es lo que detectó Gemini en el fotograma analizado más cercano; mueve la barra de tiempo para recorrerlos.</p>
          )}
        </section>

        <aside className="overflow-hidden rounded-lg border border-line bg-surface lg:sticky lg:top-4">
          <div role="tablist" aria-label="Configuración" className="grid grid-cols-4 border-b border-line">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                aria-selected={panel === tab.id}
                aria-controls={`panel-${tab.id}`}
                onClick={() => setPanel(tab.id)}
                className={`flex items-center justify-center gap-1.5 border-b-2 px-1 py-2.5 text-xs font-medium transition-colors ${
                  panel === tab.id ? "border-[var(--series-1)] text-foreground" : "border-transparent text-ink-2 hover:text-foreground"
                }`}
              >
                <span aria-hidden className={`size-1.5 rounded-full ${tab.ready ? "bg-[var(--ok)]" : "bg-[var(--line)]"}`} />
                {tab.label}
                <span className="sr-only">{tab.ready ? "(listo)" : "(pendiente)"}</span>
              </button>
            ))}
          </div>

          <div className="p-4">
            <fieldset id="panel-video" role="tabpanel" aria-labelledby="tab-video" hidden={panel !== "video"} disabled={locked} className="space-y-4">
              <div className="grid grid-cols-2 gap-2">
                <label className={`btn ${recording ? "pointer-events-none opacity-50" : "cursor-pointer"}`}>
                  Subir video
                  <input
                    type="file"
                    accept="video/*"
                    className="sr-only"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void loadVideo(file, file.name);
                      event.target.value = "";
                    }}
                  />
                </label>
                {recording ? (
                  <button type="button" className="btn" onClick={() => recorderRef.current?.stop()}>Detener</button>
                ) : (
                  <button type="button" className="btn" onClick={() => void startCamera()}>Grabar con cámara</button>
                )}
              </div>
              {videoName && <p className="truncate text-xs text-ink-2" title={videoName}>{videoName}</p>}
              <div className="space-y-2">
                <span className="block text-xs text-ink-2">Método</span>
                <div className="grid grid-cols-3 gap-1 rounded-md border border-line p-1">
                  {METHOD_OPTIONS.map((option) => (
                    <label
                      key={option.value}
                      className={`cursor-pointer rounded px-2 py-1.5 text-center text-xs font-medium has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[var(--series-1)] ${
                        method === option.value ? "bg-[var(--series-1)] text-white" : "text-ink-2 hover:bg-background"
                      }`}
                    >
                      <input type="radio" name="method" className="sr-only" checked={method === option.value} onChange={() => setMethod(option.value)} />
                      {option.label}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-ink-2">{METHOD_OPTIONS.find((option) => option.value === method)?.detail}</p>
              </div>
              {usesGemini && (
                <div className="grid grid-cols-[1fr_6rem] gap-3">
                  <label className="field">
                    <span>Qué debe buscar</span>
                    <input type="text" maxLength={200} value={description} onChange={(e) => changeDescription(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>Fotogramas IA</span>
                    <input type="number" min="4" step="1" value={geminiMaxFrames} onChange={(e) => setGeminiMaxFrames(e.target.value)} />
                  </label>
                </div>
              )}
            </fieldset>

            <fieldset id="panel-calibracion" role="tabpanel" aria-labelledby="tab-calibracion" hidden={panel !== "calibracion"} disabled={locked || !loaded} className="space-y-4">
              {!loaded && <p className="text-xs text-ink-2">Primero carga un video: la regla se busca sola.</p>}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">Regla</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      rulerSource === "ai" || (rulerSource === "manual" && rulerPixels > 0)
                        ? "bg-[var(--ok)]/15 text-[var(--ok)]"
                        : rulerSource === "failed"
                          ? "bg-[var(--series-2)]/15 text-[var(--series-2)]"
                          : "bg-background text-ink-2"
                    }`}
                  >
                    {rulerSource === "manual" && rulerPixels === 0 ? "Marcando a mano" : RULER_STATUS[rulerSource]}
                  </span>
                </div>
                {rulerSource === "failed" && (
                  <p className="text-xs text-ink-2">
                    La IA no encontró la regla{rulerError ? ` (${rulerError})` : ""}. Márcala a mano con un clic en cada extremo.
                  </p>
                )}
                <div className="grid grid-cols-[1fr_6.5rem] gap-3">
                  <label className="field">
                    <span>Largo total de la regla (m)</span>
                    <input type="number" min="0" step="0.01" value={rulerMeters} onChange={(e) => setRulerMeters(e.target.value)} />
                  </label>
                  <label className="field">
                    <span>± (mm)</span>
                    <input type="number" min="0" step="0.5" value={rulerUncertaintyMm} onChange={(e) => setRulerUncertaintyMm(e.target.value)} />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn text-xs" disabled={rulerSource === "detecting"} onClick={() => void detectRuler()}>Buscar con IA</button>
                  <button type="button" className="btn text-xs" aria-pressed={tool === "ruler"} onClick={startManualRuler}>Corregir a mano</button>
                  {rulerPixels > 0 && <span className="self-center font-mono text-xs tabular-nums text-ink-2">{rulerPixels.toFixed(0)} px</span>}
                </div>
                {rulerAngle !== null && (rulerSource === "manual" || (rulerSource === "ai" && rulerRefined)) && (
                  <div className="flex flex-wrap items-center gap-2 rounded-md bg-background px-3 py-2 text-xs">
                    <span>Inclinación: <span className="font-mono font-semibold tabular-nums">{rulerAngle.toFixed(1)}°</span></span>
                    <button type="button" className="btn ml-auto !py-1 text-xs" onClick={() => { setThetaDeg(rulerAngle.toFixed(1)); setAngleBeforeFlat(null); }}>Usar como θ</button>
                    <span className="w-full text-ink-2">Solo es el ángulo de la rampa si la cámara está nivelada.</span>
                  </div>
                )}
                {rulerSource === "ai" && !rulerRefined && (
                  <p className="text-xs text-ink-2">No se pudo afinar la regla sobre la imagen, así que su escala tiene más incertidumbre. Revisa la línea y, si no calza, corrígela a mano.</p>
                )}
              </div>
              {usesColor && (
                <div className="space-y-3 border-t border-line pt-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className="btn" aria-pressed={tool === "color"} onClick={() => setTool("color")}>Elegir color</button>
                    {targetColor ? (
                      <span className="flex items-center gap-2 text-xs text-ink-2">
                        <span
                          className="inline-block size-5 rounded border border-line"
                          style={{ background: `hsl(${targetColor.h} ${targetColor.s * 100}% ${(targetColor.v * (1 - targetColor.s / 2)) * 100}%)` }}
                        />
                        Círculo azul: lo que detecta
                      </span>
                    ) : (
                      <span className="text-xs text-ink-2">sin elegir</span>
                    )}
                  </div>
                  <label className="field">
                    <span>Tolerancia de tono: {hueTolerance}°</span>
                    <input type="range" min={3} max={45} value={hueTolerance} onChange={(e) => setHueTolerance(Number(e.target.value))} className="accent-[var(--series-1)]" />
                  </label>
                </div>
              )}
            </fieldset>

            <fieldset id="panel-experimento" role="tabpanel" aria-labelledby="tab-experimento" hidden={panel !== "experimento"} disabled={locked} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="field">
                  <span>Ángulo θ (°)</span>
                  <input type="number" min="0" max="90" step="0.1" value={thetaDeg} onChange={(e) => { setThetaDeg(e.target.value); setAngleBeforeFlat(null); }} />
                </label>
                <label className="field">
                  <span>Incertidumbre de θ (°)</span>
                  <input type="number" min="0" step="0.1" value={uThetaDeg} onChange={(e) => setUThetaDeg(e.target.value)} />
                </label>
                <label className="field">
                  <span>fps del video</span>
                  <input type="number" min="1" step="1" value={fps} onChange={(e) => setFps(e.target.value)} />
                </label>
                <label className="field">
                  <span>Muestras por segundo</span>
                  <input type="number" min="1" step="1" value={samplesPerSecond} onChange={(e) => setSamplesPerSecond(e.target.value)} />
                </label>
                <label className="field">
                  <span>g (m/s²)</span>
                  <input type="number" min="0" step="0.01" value={gravity} onChange={(e) => setGravity(e.target.value)} />
                </label>
              </div>
              {angleBeforeFlat !== null && (
                <p role="note" className="text-xs text-ink-2">Ángulo puesto en 0° porque la descripción dice que la superficie es plana. Puedes cambiarlo.</p>
              )}
              {effectiveRate > 0 && effectiveRate !== rate && (
                <p className="text-xs text-ink-2">Se usará 1 de cada {Math.round(videoFps / effectiveRate)} fotogramas: {effectiveRate.toFixed(1)} muestras por segundo.</p>
              )}
              <p className="text-xs text-ink-2">El tramo se marca con la barra de tiempo bajo el video.</p>
            </fieldset>

            <fieldset id="panel-carrito" role="tabpanel" aria-labelledby="tab-carrito" hidden={panel !== "carrito"} disabled={locked} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="field">
                  <span>Masa total (g)</span>
                  <input type="number" min="0" step="0.1" value={totalMassG} onChange={(e) => setTotalMassG(e.target.value)} />
                </label>
                <label className="field">
                  <span>Número de ruedas</span>
                  <input type="number" min="1" step="1" value={wheelCount} onChange={(e) => setWheelCount(e.target.value)} />
                </label>
                <label className="field">
                  <span>Masa de cada rueda (g)</span>
                  <input type="number" min="0" step="0.1" value={wheelMassG} onChange={(e) => setWheelMassG(e.target.value)} />
                </label>
                <label className="field">
                  <span>Forma de la rueda</span>
                  <select
                    value={wheelShape}
                    onChange={(e) => setWheelShape(e.target.value)}
                    className="w-full rounded-md border border-line bg-background px-2 py-1.5 text-sm"
                  >
                    {WHEEL_SHAPES.map((shape) => <option key={shape.value} value={shape.value}>{shape.label}</option>)}
                  </select>
                </label>
                <label className="field">
                  <span>Resistencia μ</span>
                  <input type="number" min="0" step="0.001" value={mu} onChange={(e) => setMu(e.target.value)} />
                </label>
                <label className="field">
                  <span>Incertidumbre de μ</span>
                  <input type="number" min="0" step="0.001" value={uMu} onChange={(e) => setUMu(e.target.value)} />
                </label>
              </div>
              <p className="text-xs text-ink-2">
                {usesRotation ? <>I/MR² = <span className="font-mono tabular-nums">{inertiaRatio.toFixed(4)}</span>. </> : "Sin masa de ruedas, el modelo no incluye su rotación. "}
                La masa total incluye las ruedas. Mide μ con una corrida en plano (θ = 0°) y copia aquí el valor que te dan los resultados.
              </p>
            </fieldset>
          </div>

          <div className="space-y-2 border-t border-line p-4">
            <button type="button" className="btn-primary w-full" disabled={locked || blockers.length > 0} onClick={() => void analyze()}>
              {busy ? "Analizando…" : "Analizar"}
            </button>
            {markSource.length >= MIN_FRAMES_FOR_FIT && !locked && (
              <button type="button" className="btn w-full" onClick={startMarking}>
                {marks.length > 0 ? "Repetir marcado manual" : "Marcar fotogramas a mano"}
              </button>
            )}
            <p className="text-xs text-ink-2" role="status">
              {busy ? progress : blockers.length > 0 ? `Falta: ${blockers.join(", ")}.` : "Listo para analizar."}
            </p>
          </div>
        </aside>
      </div>

      {message && <p role="alert" className="rounded-lg border border-line bg-surface p-3 text-sm">{message}</p>}
      {run && <Results run={run} marks={marks} onSave={(entries) => setRuns([...savedRuns, ...entries])} />}
      <RunLog
        entries={savedRuns}
        onRemove={(id) => setRuns(savedRuns.filter((entry) => entry.id !== id))}
        onClear={() => setRuns([])}
      />
    </main>
  );
}
