// object-ref añadido: armas, artefactos, objetos con relevancia narrativa.
export type AnnotationType =
  | 'dialogue'
  | 'narration'
  | 'character-ref'
  | 'location-ref'
  | 'object-ref' // NUEVO
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
  // Verde azulado para distinguirlo de location-ref (amarillo) y character-ref (verde)
  'object-ref': {
    label: 'Objeto',
    color: 'rgba(103,232,249,0.20)',
    border: '#22d3ee',
  },
  'internal-thought': {
    label: 'Pensamiento',
    color: 'rgba(196,181,253,0.30)',
    border: '#a78bfa',
  },
  'scene-break': {
    label: 'Corte de escena',
    color: 'transparent',
    border: '#475569',
  },
  title: {
    label: 'Título',
    color: 'rgba(234,179,8,0.18)',
    border: '#ca8a04',
  },
};
