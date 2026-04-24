// ─── Tipos de anotación ───────────────────────────────────────────────────────

export type AnnotationType =
  | 'dialogue' // Palabras dichas en voz alta
  | 'beat' // Acción/atribución dentro del diálogo
  | 'narration' // Prosa narrativa pura
  | 'character-ref' // Referencia a un personaje
  | 'location-ref' // Referencia a un lugar
  | 'internal-thought'; // Pensamiento interno del personaje

// ─── Anotación individual ─────────────────────────────────────────────────────

export interface TextAnnotation {
  id: string;
  type: AnnotationType;
  /**
   * Offset de carácter inclusivo en fullText.
   * fullText = contenidos de texto de cada bloque separados por '\n',
   * tal como los devuelve buildLLMContext() en change-tracker.extension.ts.
   */
  start: number;
  /** Offset de carácter exclusivo en fullText. */
  end: number;
  /** Metadatos extra (p.ej. nombre del personaje, nombre del lugar). */
  metadata?: Record<string, string>;
}

// ─── Configuración visual por tipo ────────────────────────────────────────────

export interface AnnotationVisual {
  label: string;
  /** Color de fondo para la leyenda y el highlight */
  color: string;
  /** Color de borde inferior (línea de "subrayado") */
  border: string;
}

export const ANNOTATION_VISUAL: Record<AnnotationType, AnnotationVisual> = {
  dialogue: { label: 'Diálogo', color: 'rgba(252,165,165,0.30)', border: '#f87171' },
  beat: { label: 'Beat', color: 'rgba(249,168,212,0.30)', border: '#f472b6' },
  narration: { label: 'Narración', color: 'rgba(147,197,253,0.22)', border: '#60a5fa' },
  'character-ref': { label: 'Personaje', color: 'transparent', border: '#34d399' },
  'location-ref': { label: 'Lugar', color: 'rgba(253,230,138,0.35)', border: '#fbbf24' },
  'internal-thought': { label: 'Pensamiento', color: 'rgba(196,181,253,0.30)', border: '#a78bfa' },
};
