# Laboratorio de Movimiento

Aplicación web que mide la **posición, velocidad y aceleración de un carrito en un plano inclinado** a partir de un video. Localiza el carrito con dos métodos —**IA (Gemini)** y **seguimiento por color (HSV)**— y compara cada resultado con un modelo teórico que incluye la rotación de las ruedas y la resistencia al movimiento, con sus incertidumbres.

Versión publicada: https://laboratorio-movimiento.vercel.app

## Cómo correrla

Requisitos: Node.js 20 o superior y una clave de la API de Gemini (Google AI Studio).

```bash
npm install
cp .env.example .env     # y escribir la clave en GEMINI_API_KEY
npm run dev              # http://localhost:3000
```

El método por color funciona sin clave. La clave solo se usa en el servidor (`src/app/api`) y nunca llega al navegador.

Variables de entorno (`.env`):

| Variable | Para qué sirve | Valor por defecto |
|---|---|---|
| `GEMINI_API_KEY` | Clave de la API de Gemini | (obligatoria para usar IA) |
| `GEMINI_MODEL` | Modelo de Gemini | `gemini-3.5-flash-lite` |

Otros comandos: `npm run build` (compilar), `npm run lint` (revisar el código) y `npx vercel deploy --prod` (publicar).

## Estructura

| Carpeta | Contenido |
|---|---|
| `src/app/` | Página principal, diseño general y estilos |
| `src/app/api/` | Rutas del servidor: `detect-gemini` (carrito) y `detect-ruler` (regla). Son lo único que usa la clave |
| `src/components/` | Interfaz: pantalla principal, resultados, gráficas y corridas guardadas |
| `src/lib/` | Lógica: física y ajustes, detección por color, ajuste fino de la regla, video, conexión con Gemini y almacenamiento de corridas |

## Cómo reproducir un resultado

1. Grabar el carrito con la cámara fija y una **regla visible, paralela al movimiento y en el mismo plano** que él. Para el método por color, pegar una marca de color al carrito.
2. Abrir la app y subir el video. La regla se detecta sola con IA; hay que escribir su **largo total** en metros y revisar que la línea amarilla calce sobre ella.
3. Elegir el color de la marca (método por color), indicar el ángulo θ con su incertidumbre, los fps del video, y marcar con la barra de tiempo el inicio y el fin del tramo en que el carrito se mueve libre.
4. En la pestaña *Carrito*, escribir la masa total, el número de ruedas, la masa de cada rueda, su forma y la resistencia μ.
5. Pulsar **Analizar**. Con el método *Ambos*, un interruptor en los resultados permite comparar con **los fotogramas de cada método** o con **exactamente los mismos fotogramas en los dos**, para separar la diferencia del detector de la que viene de la cantidad de datos.
6. Opcional: **Marcar fotogramas a mano** para medir el error de seguimiento. La app separa el error total en un **desfase fijo** (sistemático) y una **variación** entre fotogramas (aleatoria), con total² = desfase² + variación², y lo muestra también en una gráfica.
7. **Guardar en corridas** y descargar el CSV. Las repeticiones del mismo ángulo y método se resumen con promedio, desviación estándar y error de la media; las corridas hechas con los mismos fotogramas se resumen aparte.

Para medir μ, se hace primero una corrida en plano (θ = 0°): la app despeja μ con su incertidumbre, y ese valor se usa en las corridas en rampa.

## Parámetros por defecto

| Parámetro | Valor |
|---|---|
| Fotogramas por solicitud a Gemini | hasta 20 |
| Muestras por segundo | 30 |
| fps del video | 60 |
| Tolerancia de tono (HSV) | 15° |
| Incertidumbre del ángulo θ | 0.5° |
| Incertidumbre de la regla | 1 mm |
| g | 9.81 m/s² |
| Ancho máximo de trabajo del fotograma | 960 px |

## Modelo

La posición se ajusta por mínimos cuadrados a una parábola, `x(t) = At² + Bt + C`, y la aceleración medida es `a = 2A`. La teoría es

```
a = g (sin θ − μ cos θ) / (1 + I/MR²),    I/MR² = n·k·m / M
```

con `g` la gravedad (m/s²), `θ` el ángulo de la rampa, `μ` la resistencia al movimiento (adimensional), `M` la masa total del carrito (kg), `n` el número de ruedas, `m` la masa de cada rueda (kg) y `k` = ½ para un disco o 1 para un aro. La incertidumbre de la medición combina el error del ajuste con el de la calibración; la de la teoría se propaga desde `θ` y `μ`. La discrepancia se expresa como `|a_exp − a_teo| / √(u_exp² + u_teo²)`, y menos de 2 se considera compatible.

## Estado y limitaciones

- No hay pruebas automáticas. El funcionamiento se verificó con videos sintéticos de aceleración conocida generados a mano; falta validarlo con videos reales del carrito.
- Gemini depende de internet y de la cuota de la clave; el tiempo de respuesta varía.
- Las corridas guardadas viven en el almacenamiento del navegador de cada persona; hay que compartir el CSV.
- La escala supone cámara perpendicular al plano del movimiento y regla en ese mismo plano.
