/**
 * What Gemini must return when it reads a plan (standard JSON Schema, sent as
 * responseJsonSchema). Coordinates are normalized
 * from 0 to 1000 over the image (0,0 = top-left corner), which is the box
 * convention Gemini was trained with; the analyzer converts them to meters.
 */
export const PLAN_TYPES = ['Muro', 'Columna', 'Viga', 'Losa', 'Puerta', 'Ventana', 'Escalera'] as const;

const NUM = { type: 'number', minimum: 0, maximum: 1000 };

export const PLAN_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    legible: { type: 'boolean', description: 'false si el plano no se puede interpretar con confianza' },
    issues: {
      type: 'array',
      description: 'Problemas de calidad: borroso, inclinado, recortado, sin escala, manuscrito...',
      items: { type: 'string' },
    },
    scaleText: { type: ['string', 'null'], description: 'Escala escrita en el plano, p. ej. "1:100", o null' },
    elements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: [...PLAN_TYPES] },
          x1: NUM,
          y1: NUM,
          x2: NUM,
          y2: NUM,
          confidence: { type: 'number', minimum: 0, maximum: 1, description: '0 a 1, qué tan seguro estás' },
        },
        required: ['type', 'x1', 'y1', 'x2', 'y2', 'confidence'],
      },
    },
    rooms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          x1: NUM,
          y1: NUM,
          x2: NUM,
          y2: NUM,
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['name', 'x1', 'y1', 'x2', 'y2', 'confidence'],
      },
    },
    dimensions: {
      type: 'array',
      description: 'Cotas escritas en el plano',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, meters: { type: ['number', 'null'] } },
        required: ['text'],
      },
    },
  },
  required: ['legible', 'issues', 'elements', 'rooms', 'dimensions'],
};

export const PLAN_PROMPT = `Eres un asistente de interpretación de planos arquitectónicos 2D para ingeniería civil.
Analiza la imagen y devuelve SOLO lo que se ve dibujado. Reglas:
- No inventes información. Si algo no se ve, no lo incluyas. Ante la duda baja "confidence".
- Coordenadas normalizadas de 0 a 1000 sobre la imagen completa; (0,0) es la esquina superior izquierda.
- Muro, Viga: x1,y1 = un extremo del eje del elemento; x2,y2 = el otro extremo. Los muros son tramos rectos;
  parte los muros en cada puerta o ventana, como en el plano.
- Puerta, Ventana: x1,y1 y x2,y2 = los extremos del vano sobre el eje del muro donde está.
- Columna, Losa, Escalera: x1,y1 = esquina superior izquierda y x2,y2 = esquina inferior derecha de su caja.
- Habitaciones (rooms): nombre como está escrito (o "Espacio" si no tiene) y su caja.
- Cotas (dimensions): copia el texto de cada cota legible y su valor en metros si se puede leer.
- issues: menciona si la imagen está borrosa, inclinada, recortada, sin escala o con anotaciones a mano.
- legible=false SOLO si la imagen no es un plano o no se distinguen los muros. Textos pequeños o poco nítidos
  no hacen ilegible el plano: menciónalos en issues y sigue con los muros, columnas, vanos y espacios que sí se ven.
- Si no es un plano, responde legible=false, explica en issues y deja las listas vacías.`;
