import { TextAnnotation } from './semantic-annotations.types';

/** Anotación enriquecida con el índice del chunk y el análisis que la generó. */
export type LiveAnnotation = TextAnnotation & {
  chunkIndex: number;
  analysisType: AnalysisType;
};

/** Estado del procesamiento de un chunk. */
export type ChunkStatus = 'thinking' | 'generating' | 'done' | 'error';

/**
 * Tipo de análisis que generó este chunk.
 * Cada endpoint tiene un tipo propio; las anotaciones de los tres conviven en el editor.
 */
export type AnalysisType = 'refs' | 'blocks' | 'conversations';

/**
 * Registro de un chunk procesado por un endpoint (una sola pasada LLM).
 *
 * La estructura es deliberadamente más simple que en v5: ya no hay dos pasadas
 * (refs + blocks) dentro del mismo log. Cada endpoint genera sus propios ChunkLogs
 * independientes, todos mezclados en el array compartido del componente pero
 * diferenciados por `analysisType`.
 */
export interface ChunkLog {
  index: number;
  total: number;
  preview: string;
  /** Texto completo enviado al LLM — visible en el panel de debug. */
  inputText: string;
  /** Qué endpoint generó este chunk. */
  analysisType: AnalysisType;
  /** Razonamiento interno del modelo (DeepSeek-R1, QwQ, etc.), si procede. */
  thinkContent: string;
  /** XML crudo devuelto por el modelo. */
  xmlContent: string;
  annotations: LiveAnnotation[];
  status: ChunkStatus;
  errorMessage?: string;
}
