// Solo para rutas del servidor: usa la clave de Gemini.
const GEMINI_TIMEOUT_MS = 60_000;

export const MAX_DESCRIPTION_CHARS = 200;
// Vercel rechaza cuerpos de más de 4.5 MB.
export const MAX_TOTAL_IMAGE_CHARS = 4_000_000;

export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === request.headers.get("host");
  } catch {
    return false;
  }
}

type GeminiResult = { data: unknown } | { error: string; status: number };

export async function generateJson(parts: object[], responseSchema: object): Promise<GeminiResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { error: "Falta GEMINI_API_KEY en web/.env", status: 500 };

  const model = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema },
    }),
  }).catch(() => null);

  if (!response) return { error: `Gemini no respondió en ${GEMINI_TIMEOUT_MS / 1000} s`, status: 504 };
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    return { error: detail?.error?.message ?? `Gemini respondió ${response.status}`, status: response.status };
  }

  const data = await response.json();
  try {
    return { data: JSON.parse(data?.candidates?.[0]?.content?.parts?.[0]?.text) };
  } catch {
    return { error: "Gemini no devolvió JSON válido", status: 502 };
  }
}
