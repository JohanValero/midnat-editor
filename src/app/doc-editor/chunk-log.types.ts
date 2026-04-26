import { TextAnnotation } from './semantic-annotations.types';

/** Anotación enriquecida con el índice del chunk que la generó. */
export type LiveAnnotation = TextAnnotation & { chunkIndex: number };

/** Estado del procesamiento de un chunk. */
export type ChunkStatus = 'thinking' | 'generating' | 'done' | 'error';

/** Nombre de la pasada LLM activa. */
export type PassName = 'refs' | 'blocks';

/**
 * Registro completo de un chunk procesado por las dos pasadas LLM (v5).
 *
 * Cada pasada tiene su propio contenido de thinking y XML para facilitar
 * la depuración independiente de cada tarea (referencias vs bloques).
 */
export interface ChunkLog {
  index: number;
  total: number;
  preview: string;
  /** Texto completo enviado al LLM — visible en el panel de debug. */
  inputText: string;
  /** Pasada en curso; null antes del primer pass_start y tras el progress. */
  currentPass: PassName | null;

  // ── Pasada 1 — referencias ───────────────────────────────────────────
  refsThinkContent: string; // razonamiento interno de la pasada refs
  refsXmlContent: string; // XML <refs>…</refs> generado

  // ── Pasada 2 — bloques narrativos ────────────────────────────────────
  blocksThinkContent: string; // razonamiento interno de la pasada blocks
  blocksXmlContent: string; // XML <annotations>…</annotations> generado

  annotations: LiveAnnotation[];
  status: ChunkStatus;
  errorMessage?: string;
}
