import { generateJson, isSameOrigin, MAX_DESCRIPTION_CHARS, MAX_TOTAL_IMAGE_CHARS } from "@/lib/gemini";

const MAX_IMAGES = 30;

type RawDetection = { image?: number; found?: boolean; box_2d?: number[] };

// Margen sobre el límite de Gemini, para que el aviso de tiempo agotado alcance a responder.
export const maxDuration = 70;

export async function POST(request: Request) {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Solicitud no permitida" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const images: unknown = body?.images;
  const description = String(body?.description ?? "carrito con ruedas").slice(0, MAX_DESCRIPTION_CHARS);
  if (
    !Array.isArray(images) ||
    images.length === 0 ||
    images.length > MAX_IMAGES ||
    !images.every((image) => typeof image === "string" && image.length > 0) ||
    images.reduce((total: number, image: string) => total + image.length, 0) > MAX_TOTAL_IMAGE_CHARS
  ) {
    return Response.json({ error: "Imágenes inválidas" }, { status: 400 });
  }

  const result = await generateJson(
    [
      ...images.flatMap((image: string, i: number) => [
        { text: `Imagen ${i + 1}:` },
        { inlineData: { mimeType: "image/jpeg", data: image } },
      ]),
      {
        text: `Son ${images.length} fotogramas de un video con cámara fija. En cada uno, localiza por separado el siguiente objeto: ${description}. Devuelve un elemento por imagen, con image igual a su número, found=true y box_2d con su caja delimitadora ajustada como [ymin, xmin, ymax, xmax] normalizada de 0 a 1000. Mide cada imagen por sí sola, sin suponer una trayectoria. Si no aparece, devuelve found=false.`,
      },
    ],
    {
      type: "OBJECT",
      properties: {
        detections: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              image: { type: "INTEGER" },
              found: { type: "BOOLEAN" },
              box_2d: { type: "ARRAY", items: { type: "INTEGER" } },
            },
            required: ["image", "found"],
          },
        },
      },
      required: ["detections"],
    },
  );
  if ("error" in result) return Response.json({ error: result.error }, { status: result.status });

  const parsed = result.data as { detections?: RawDetection[] } | null;
  const detections = (parsed?.detections ?? []).flatMap((detection) => {
    const box = detection.box_2d;
    const index = (detection.image ?? 0) - 1;
    if (!detection.found || !Array.isArray(box) || box.length !== 4) return [];
    if (index < 0 || index >= images.length) return [];
    const [ymin, xmin, ymax, xmax] = box;
    return [{
      index,
      x: (xmin + xmax) / 2000,
      y: (ymin + ymax) / 2000,
      box: { xmin: xmin / 1000, ymin: ymin / 1000, xmax: xmax / 1000, ymax: ymax / 1000 },
    }];
  });
  return Response.json({ detections });
}
