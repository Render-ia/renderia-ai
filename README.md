# Render.IA — Servicio de IA

Componente de inteligencia artificial de **Render.IA**: recibe la imagen de un plano 2D y devuelve los elementos estructurales que encuentra (muros, columnas, vigas, losa, puertas y ventanas), con sus medidas en metros y un nivel de confianza.

Proyecto final de **Patrones de Software** — Universidad Cooperativa de Colombia, sede Pasto.

- **Integrantes:** Juan David Moreno, Felipe Cerón
- **Backend:** [renderia-backend](https://github.com/Render-ia/renderia-backend) (Java 21 + Spring Boot)
- **Frontend:** [renderia-frontend](https://github.com/Render-ia/renderia-frontend)
- **Base de datos:** [renderia-database](https://github.com/Render-ia/renderia-database)

## Lugar en la arquitectura

```mermaid
flowchart LR
    F[Frontend] --> B[Backend Java]
    B --> D[(PostgreSQL)]
    B -- "POST /analyze" --> I[Servicio de IA]
    I -- "descarga la imagen" --> B
```

El backend le pide el análisis a este servicio, este descarga la imagen del plano desde el backend, la analiza y devuelve los elementos. El backend los guarda en `ai_analyses` y `structural_elements`.

El servicio es **independiente**: se puede cambiar de modelo de IA sin tocar el backend, el frontend ni la base de datos.

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | Estado del servicio |
| GET | `/models` | Proveedores de IA disponibles |
| POST | `/analyze` | Analiza un plano |
| POST | `/assistant` | Copiloto de ingeniería (Gemini) sobre el plano y el modelo del proyecto |

### POST /analyze

```json
{
  "imageUrl": "https://renderia-backend.onrender.com/api/v1/floor-plans/1/image",
  "scale": "1:100",
  "provider": "local-vision",
  "modelIdentifier": "renderia-vision-v1"
}
```

Respuesta:

```json
{
  "provider": "local-vision",
  "model": "Detector de visión local",
  "durationMs": 412,
  "elements": [
    { "type": "Muro", "material": "Ladrillo", "startX": 0.64, "startY": 0.8, "endX": 2.3, "endY": 0.8,
      "width": null, "height": 2.5, "thickness": 0.15, "confidence": 0.71 }
  ],
  "summary": { "counts": { "walls": 18, "columns": 11, "doors": 6, "windows": 5, "beams": 15 } }
}
```

Errores: `400` si la petición está mal, `401` si falta la clave, `422` si el plano no se puede analizar (por ejemplo, si está en blanco). El cuerpo siempre es `{ "message": "..." }` en español.

## Modelos disponibles

| `provider` | Nombre | Cómo funciona |
|---|---|---|
| `local-vision` | Detector de visión local | Visión por computador clásica (ver abajo) |
| `gemini` | Gemini (visión) | Gemini lee el dibujo; reglas deterministas lo convierten en geometría (ver abajo) |
| `mock` | Respuesta de ejemplo | Devuelve siempre la casa de ejemplo; sirve para probar el flujo |

### Gemini (visión)

La IA interpreta, la geometría determinista construye y el usuario valida:

1. El plano se convierte a PNG (máximo 2048 px) y se envía a Gemini con un **esquema JSON obligatorio**: tipos del catálogo, coordenadas normalizadas 0–1000 y confianza 0–1 por elemento, habitaciones, cotas leídas, escala escrita y problemas de calidad.
2. `GeminiAnalyzer.toOutput` es una función pura que **no confía** en la respuesta: descarta tipos desconocidos, recorta coordenadas fuera de la imagen, endereza muros casi ortogonales, rechaza "columnas" de más de 1,5 m y convierte a metros con la escala del plano.
3. Lo que el plano no dice (alturas, espesores, losa) se llena con valores por defecto y se reporta en `summary.assumptions` con origen `supuesto`, para que el usuario lo confirme.
4. Si la escala escrita en el plano no coincide con la elegida, o no hay escala ni cotas, sale en `summary.warnings`.

El modelo exacto lo define `ai_models.model_identifier` (por defecto `gemini-2.5-flash`), así que se cambia desde el panel de administración sin desplegar.

### POST /assistant

```json
{
  "question": "¿Qué muros tienen menos de 12 cm de espesor?",
  "context": { "project": { "name": "Casa" }, "elements": [{ "id": 12, "type": "Muro", "thickness": 0.1 }] },
  "history": [{ "role": "user", "text": "..." }, { "role": "model", "text": "..." }]
}
```

Responde `{ "answer": "...", "proposals": [{ "title", "reason", "operations": [{ "op": "update", "elementId": 12, "field": "thickness", "value": 0.15 }] }] }`. Las propuestas se filtran: solo ids que existen en el contexto, solo `height`, `thickness` o `width`, valores entre 1 cm y 50 m. El copiloto **nunca aplica cambios**: el frontend los muestra y el usuario confirma. Tampoco certifica la NSR-10 ni reemplaza la revisión de un profesional.

### Detector de visión local

1. Convierte la imagen a blanco y negro con el **umbral de Otsu**.
2. Mide el **grosor típico de muro** con la longitud más común de los trazos.
3. Quita líneas delgadas (texto, cotas, arcos de puertas) con una **apertura morfológica**.
4. Busca **muros** como bandas de trazos largos alineados.
5. Encuentra **columnas** erosionando la imagen: los muros desaparecen y quedan los cuadros gruesos.
6. Deduce **puertas y ventanas** de los huecos entre tramos de un muro, **vigas** entre columnas unidas por un muro y la **losa** con el contorno del edificio.
7. Pasa de píxeles a metros con la escala del dibujo (escaneo a 150 ppp).

Con `samples/house-floor-plan.svg` a escala 1:100 encuentra 18 muros, 11 columnas, 6 puertas, 5 ventanas, 15 vigas y la losa (lo comprueban las pruebas).

## Patrones de diseño

| Patrón | Dónde | Para qué |
|---|---|---|
| **Strategy** | `PlanAnalyzer` → `LocalVisionAnalyzer`, `GeminiAnalyzer`, `SampleAnalyzer` | Cada modelo de IA analiza el plano a su manera detrás de la misma interfaz |
| **Factory** | `AnalyzerFactory` | Elige el analizador según `ai_models.provider`: el "switch" de modelos |
| **Facade** | `AnalysisService`, `AssistantService` | Una sola llamada valida, descarga la imagen, elige el modelo y lo ejecuta; el copiloto valida, consulta y filtra |
| **Adapter** | `GeminiClient` | Traduce la API REST de Gemini a una llamada `generateJson` tipada |

### Cómo agregar otro modelo

1. Crear una clase en `src/analyzers/` que implemente `PlanAnalyzer`.
2. Registrarla en `AnalyzerFactory`.
3. Agregar la fila en la tabla `ai_models` con el mismo `provider` y activarla desde el panel de administración.

## Seguridad

- Solo descarga imágenes de las URL permitidas en `IMAGE_URL_PREFIXES` (por defecto, el backend), con un máximo de 10 MB y 30 segundos.
- `AI_API_KEY` es **obligatoria en producción** (`NODE_ENV=production` o `RENDER=true`): sin ella el servicio no arranca. `/analyze` y `/assistant` la exigen en `X-API-Key` y se compara en tiempo constante. En local, si falta, queda abierto con un aviso.
- En producción solo se aceptan imágenes del backend de Render (sin `localhost`).
- La clave de Gemini viaja en el encabezado `x-goog-api-key`, nunca en la URL ni en los logs.
- El copiloto trata el contexto y el historial como datos, no como instrucciones, y filtra sus propuestas antes de devolverlas.
- Respuestas con `Cache-Control: no-store`, `nosniff`, CSP `default-src 'none'` y `Referrer-Policy: no-referrer`.

## Variables de entorno

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` | `8000` | Puerto del servidor |
| `AI_API_KEY` | vacío (obligatoria en producción) | Clave compartida con el backend |
| `IMAGE_URL_PREFIXES` | backend de Render (+ `localhost:8080` en local) | Desde dónde se pueden descargar imágenes |
| `GEMINI_API_KEY` | vacío | Clave de Google AI Studio. Sin ella el proveedor `gemini` responde un error claro |
| `GEMINI_CHAT_MODEL` | `gemini-2.5-flash` | Modelo del copiloto |

Ejemplo completo en [`.env.example`](.env.example).

## Cómo ejecutarlo

```bash
npm install
npm test          # compila y corre las pruebas
npm start         # http://localhost:8000/health
```

## Tecnologías

Node.js 22, TypeScript, [sharp](https://sharp.pixelplumbing.com/) para leer PNG, JPG, WEBP y SVG, Docker y GitHub Actions.
