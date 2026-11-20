# Integración de Gemini en Render.IA

Informe técnico de la integración (noviembre de 2026). Modelos y precios verificados el 2026-11-20 en
[ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models) y
[ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing).

## 1. Arquitectura encontrada

```
Navegador (Vercel, TS + Vite + Three.js)
   │  HTTPS + JWT
   ▼
Backend (Render, Java 21 + Spring Boot)  ── JPA ──►  PostgreSQL (Neon)
   │  HTTPS + X-API-Key (AiServiceClient)
   ▼
Servicio de IA (Render, Node 22 + TS, node:http sin framework)
   ├─ LocalVisionAnalyzer   detector geométrico determinista (sharp)
   ├─ SampleAnalyzer        respuesta de ejemplo
   └─ (nuevo) Gemini        ──►  Gemini API (@google/genai)
```

- El navegador nunca habla con el servicio de IA: pide `POST /api/v1/ai/analyze` al backend, el backend revisa permisos y llama `POST /analyze` con la URL de la imagen del plano.
- El servicio de IA descarga la imagen solo desde el backend (`IMAGE_URL_PREFIXES`) y elige el analizador con `ai_models.provider` (patrón Strategy + Factory).
- Antes de esta integración **no había código de Gemini**; solo un comentario en `AnalyzerFactory`.

## 2. Archivos creados y modificados (renderia-ai)

| Archivo | Qué es |
|---|---|
| `src/gemini/GeminiClient.ts` | Adapter: única clase que usa el SDK. JSON con esquema, imágenes, reintento, timeout, errores legibles |
| `src/gemini/GeminiBudget.ts` | Tope diario de llamadas del servicio |
| `src/gemini/PlanReader.ts` | Pide a Gemini la lectura del plano y la convierte a metros con reglas deterministas |
| `src/gemini/planSchema.ts` | Esquema JSON y prompt de lectura de planos |
| `src/analyzers/GeminiAnalyzer.ts` | Proveedor `gemini`: geometría determinista + interpretación de Gemini + comparación |
| `src/assistant/AssistantService.ts` | Copiloto de ingeniería |
| `src/render/RenderService.ts` | Render con IA a partir de la vista del modelo 3D (opcional) |
| `src/config.ts` | Variables de Gemini y `resolveGeminiModel` |
| `src/server.ts` | `/assistant`, `/render`, `/capabilities`, cabeceras de seguridad |
| `src/analyzers/AnalyzerFactory.ts` | Registra Gemini y expone `configured` |
| `test/gemini.test.ts` | 17 pruebas con el SDK simulado |

## 3. Dependencias

Una sola: `@google/genai` **3.6.1** (SDK oficial de Google, requiere Node 22, igual que el servicio). Versión fijada exacta.

## 4. Funcionalidades

| Del pedido | Estado | Cómo |
|---|---|---|
| A. Análisis de planos | Hecho | Gemini complementa al detector: habitaciones, cotas, escala anotada, calidad, y compara conteos. La geometría guardada sigue siendo la determinista; Gemini solo propone geometría si el detector no puede leer el plano, con confianza reducida y advertencia |
| B. Copiloto | Hecho en el servicio | `POST /assistant`: contexto del proyecto, historial, marca dato / estimación / recomendación, no inventa medidas ni normas, propone cambios que el usuario confirma |
| C. Cantidades y presupuesto | Determinista | Las cantidades salen de funciones puras sobre la geometría validada (frontend). Gemini no calcula: recibe las cantidades ya hechas en el contexto del copiloto para explicarlas y señalar datos faltantes |
| D. PDF | Hecho en el frontend | El PDF se dibuja a 150 ppp en el navegador (pdf.js) y se guarda como PNG. Ver la decisión abajo |
| E. Renders con IA | Implementado, apagado | `POST /render` con modelo de imagen configurable. Apagado hasta que se defina `GEMINI_IMAGE_MODEL` (es de pago) |

**Por qué el PDF se convierte en el navegador y no se manda a Gemini.** Gemini acepta PDF (hasta 50 MB o 1000 páginas), pero la geometría necesita una imagen con resolución conocida: a 150 ppp, un plano 1:100 da exactamente las medidas de la escala. Convertir en el navegador sirve para los tres analizadores (no solo Gemini), no sube el PDF completo a ningún servicio externo y deja la imagen guardada para el visor. Si más adelante se quiere que el copiloto lea un PDF de varias páginas (memorias, especificaciones), se puede mandar el PDF a Gemini como documento sin cambiar el resto.

## 5. Variables de entorno (Render → renderia-ai → Environment)

| Variable | Valor recomendado |
|---|---|
| `GEMINI_API_KEY` | La clave de Google AI Studio. **Solo aquí**: nunca en el backend, el frontend ni el repositorio |
| `GEMINI_MODEL` | `gemini-3.8-flash` (recomendado por Google para proyectos nuevos; imagen, PDF y salida estructurada) |
| `GEMINI_MODEL_PRO` | Vacío. Hoy no existe un Pro estable; `gemini-3.1-pro-preview` es preview y sin capa gratuita |
| `GEMINI_IMAGE_MODEL` | Vacío hasta autorizar el gasto. Opción recomendada por Google: `gemini-3.1-flash-image` |
| `GEMINI_DAILY_LIMIT` | `300` |
| `GEMINI_IMAGE_DAILY_LIMIT` | `20` |
| `AI_API_KEY` | Ya existente; obligatoria en producción y la misma del backend |

## 6. Endpoints nuevos o modificados (servicio de IA)

| Método | Ruta | Cambio |
|---|---|---|
| POST | `/analyze` | Sin cambios de contrato. Nuevo `provider: "gemini"`; el `summary` trae además `rooms`, `dimensions`, `scaleText`, `warnings`, `assumptions`, `geometrySource` |
| GET | `/models` | Agrega `configured` por proveedor |
| GET | `/capabilities` | Nuevo. Qué está activo y consumo del día, sin claves |
| POST | `/assistant` | Nuevo. Copiloto |
| POST | `/render` | Nuevo. Render con IA (opcional) |

Todos los POST exigen `X-API-Key`. El backend expone el copiloto y el render a los usuarios con su JWT, permisos por proyecto y límite por usuario (PR del backend).

## 7. Pruebas

`npm test`: 21 pruebas en verde, sin llamar a la API real (el SDK se reemplaza por un doble):
lectura y conversión a metros, recorte de coordenadas, plano ilegible, escala distinta, reintento ante 503, clave inválida,
id de modelo malicioso, cupo diario, resolución de modelos por entorno, análisis híbrido (geometría intacta, advertencias,
caída a geometría si Gemini falla, caída a Gemini si la geometría falla), casa de ejemplo con 56 elementos, copiloto
(validación, contexto, modelo profundo, filtro de propuestas), render (apagado, estilo, imagen falsa, prompt que conserva geometría)
y las pruebas anteriores del detector y del servidor.

Prueba real de conexión después del despliegue: `GET /capabilities` debe mostrar `gemini.configured: true`, y un análisis con el
modelo "Gemini + visión geométrica" sobre el plano de ejemplo debe traer habitaciones en el resumen.

## 8. Despliegue en Render

1. Juan David (dueño del servicio en Render) agrega las variables del punto 5 en renderia-ai.
2. Merge del PR de renderia-ai. Render construye la imagen Docker (el `Dockerfile` no cambia; `npm install` trae el SDK).
3. Merge del PR del backend: agrega la fila `Gemini + visión geométrica` (`provider = gemini`, `model_identifier = gemini:flash`) en `ai_models` al arrancar.
4. En Administración → Modelos de IA queda activo; se puede marcar como predeterminado.

## 9. Limitaciones

- La precisión de Gemini en planos no está medida todavía: falta el set de planos de prueba de la sección 10 de la propuesta.
- Gemini puede no ver lo que el dibujo no muestra claramente; por eso no decide medidas y todo pasa por validación humana.
- El cupo diario es por instancia y en memoria: si el servicio se reinicia, el conteo vuelve a cero. Con varias instancias habría que llevarlo a Redis o a la base.
- No se envían planos de varias páginas a Gemini; solo la primera página convertida a imagen.
- Los renders con IA son propuestas visuales: pueden cambiar detalles aunque el prompt pida conservar la geometría.

## 10. Costos

Precios de la página oficial el 2026-11-20 (USD, capa de pago, por millón de tokens):

| Modelo | Entrada | Salida | Capa gratuita |
|---|---|---|---|
| `gemini-3.8-flash` | No publicado en la página de precios al revisarla | — | No confirmada |
| `gemini-3.5-flash` | 1,50 | 9,00 | Sí |
| `gemini-3.1-flash-lite` | 0,25 | 1,50 | Sí |
| `gemini-3.1-pro-preview` | 2,00 | 12,00 | No |
| `gemini-3.1-flash-image` | 0,50 | ~0,067 por imagen de 1K | No |

Consumo esperado por análisis: una imagen de plano (unos pocos miles de tokens de entrada) y una respuesta JSON de 2 000 a 8 000 tokens.
Con los precios de `gemini-3.5-flash`, eso es del orden de **USD 0,02 a 0,08 por análisis** en la capa de pago, y gratis dentro de la capa gratuita.
Si `gemini-3.8-flash` resultara sin capa gratuita para la cuenta, basta con poner `GEMINI_MODEL=gemini-3.5-flash` en Render; no hay que cambiar código.

**No se activó ningún servicio de pago.** Los renders con IA quedan apagados hasta que se defina `GEMINI_IMAGE_MODEL`.
