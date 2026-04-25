export type AnnotationType =
  | 'dialogue' // Palabras dichas en voz alta
  | 'beat' // Acción/atribución dentro del diálogo
  | 'narration' // Prosa narrativa pura
  | 'character-ref' // Referencia a un personaje
  | 'location-ref' // Referencia a un lugar
  | 'internal-thought'; // Pensamiento interno del personaje

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
  beat: {
    label: 'Beat',
    color: 'rgba(249,168,212,0.30)',
    border: '#f472b6',
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
};
