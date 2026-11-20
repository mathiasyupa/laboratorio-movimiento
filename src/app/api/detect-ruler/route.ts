import { generateJson, isSameOrigin, MAX_TOTAL_IMAGE_CHARS } from "@/lib/gemini";

export const maxDuration = 70;

const isPoint = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === "number" && n >= 0 && n <= 1000);

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Solicitud no permitida" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const image = body?.image;
  if (typeof image !== "string" || image.length === 0 || image.length > MAX_TOTAL_IMAGE_CHARS) {
    return Response.json({ error: "Imagen inválida" }, { status: 400 });
  }

  const result = await generateJson(
    [
      { inlineData: { mimeType: "image/jpeg", data: image } },
      {
        text: "En la imagen hay una regla o cinta métrica que sirve de escala. Imagina la línea central que la recorre a lo largo, a mitad de su ancho. Devuelve found=true, y start y end como los puntos donde esa línea central toca cada extremo de la regla (el centro de cada borde corto, no una esquina), en formato [y, x] normalizado de 0 a 1000. Si no hay ninguna regla, devuelve found=false.",
      },
    ],
    {
      type: "OBJECT",
      properties: {
        found: { type: "BOOLEAN" },
        start: { type: "ARRAY", items: { type: "INTEGER" } },
        end: { type: "ARRAY", items: { type: "INTEGER" } },
      },
      required: ["found", "start", "end"],
    },
  );
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });

  const parsed = result.data as { found?: boolean; start?: unknown; end?: unknown } | null;
  if (!parsed?.found || !isPoint(parsed.start) || !isPoint(parsed.end)) {
    return Response.json({ found: false });
  }
  const [y0, x0] = parsed.start;
  const [y1, x1] = parsed.end;
  return Response.json({ found: true, start: { x: x0 / 1000, y: y0 / 1000 }, end: { x: x1 / 1000, y: y1 / 1000 } });
}
