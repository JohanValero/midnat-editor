import { TextAnnotation } from './semantic-annotations.types';

// ── Novela ─────────────────────────────────────────────────────────────────────

export interface Novel {
  id: number;
  title: string;
  author: string;
  description: string;
  cover_color: string;
  chapter_count: number; // campo calculado en listado
  total_words: number; // campo calculado en listado
  created_at: string;
  updated_at: string;
}

// ── Capítulo ───────────────────────────────────────────────────────────────────

/** Vista ligera usada en listas y sidebars — no incluye content_html/text. */
export interface ChapterSummary {
  id: number;
  novel_id: number;
  title: string;
  order_index: number;
  summary: string;
  word_count: number;
  has_summary: boolean; // 1/0 desde SQLite, normalizado en el servicio
  annotation_count: number;
  created_at: string;
  updated_at: string;
}

/** Vista completa con contenido y anotaciones — usada en el editor. */
export interface Chapter extends ChapterSummary {
  content_text: string; // texto plano para el LLM
  content_html: string; // HTML para TipTap
  annotations: StoredAnnotation[];
}

/** Anotación tal como llega de la BD (start/end como start_offset/end_offset). */
export interface StoredAnnotation {
  id: string;
  chapter_id: number;
  type: string;
  start_offset: number;
  end_offset: number;
  metadata: Record<string, string>;
  analysis_type: string;
}

/** Convierte una StoredAnnotation al formato TextAnnotation que usa el editor. */
export function toTextAnnotation(a: StoredAnnotation): TextAnnotation {
  return {
    id: a.id,
    type: a.type as any,
    start: a.start_offset,
    end: a.end_offset,
    metadata: a.metadata,
  };
}

// ── Requests ───────────────────────────────────────────────────────────────────

export interface NovelCreatePayload {
  title: string;
  author: string;
  description: string;
  cover_color: string;
}

export interface NovelImportPayload extends NovelCreatePayload {
  chapters: ChapterImportItem[];
}

export interface ChapterImportItem {
  title: string;
  content_text: string;
  content_html: string;
}

export interface ChapterUpdatePayload {
  title?: string;
  content_text?: string;
  content_html?: string;
  summary?: string;
  /** Si se proporciona junto con analysis_type_for_annotations, reemplaza las anotaciones. */
  annotations?: TextAnnotation[];
  analysis_type_for_annotations?: string;
}
