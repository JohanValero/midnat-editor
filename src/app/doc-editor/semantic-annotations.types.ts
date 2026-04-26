// beat eliminado: las atribuciones de diálogo son narración.
// title añadido: los títulos de capítulo/sección ahora son anotaciones visibles.
export type AnnotationType =
  | 'dialogue'
  | 'narration'
  | 'character-ref'
  | 'location-ref'
  | 'internal-thought'
  | 'scene-break'
  | 'title';

export interface TextAnnotation {
  id: string;
  type: AnnotationType;
  start: number;
  end: number;
  metadata?: Record<string, string>;
}

export interface AnnotationVisual {
  label: string;
  color: string;
  border: string;
}

export const ANNOTATION_VISUAL: Record<AnnotationType, AnnotationVisual> = {
  dialogue: {
    label: 'Diálogo',
    color: 'rgba(252,165,165,0.30)',
    border: '#f87171',
  },
  narration: {
    label: 'Narración',
    color: 'rgba(147,197,253,0.22)',
    border: '#60a5fa',
  },
  'character-ref': {
    label: 'Personaje',
    color: 'transparent',
    border: '#34d399',
  },
  'location-ref': {
    label: 'Lugar',
    color: 'rgba(253,230,138,0.35)',
    border: '#fbbf24',
  },
  'internal-thought': {
    label: 'Pensamiento',
    color: 'rgba(196,181,253,0.30)',
    border: '#a78bfa',
  },
  // scene-break: start === end, nunca genera highlight visible.
  'scene-break': {
    label: 'Corte de escena',
    color: 'transparent',
    border: '#475569',
  },
  // title: ámbar cálido, claramente distinto de location-ref (amarillo).
  title: {
    label: 'Título',
    color: 'rgba(234,179,8,0.18)',
    border: '#ca8a04',
  },
};
