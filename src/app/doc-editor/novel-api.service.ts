import { Injectable } from '@angular/core';
import {
  Chapter,
  ChapterSummary,
  ChapterUpdatePayload,
  Novel,
  NovelCreatePayload,
  NovelImportPayload,
  toTextAnnotation,
} from './novel.types';
import { TextAnnotation } from './semantic-annotations.types';

@Injectable({ providedIn: 'root' })
export class NovelApiService {
  readonly base = 'http://localhost:8000';

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const resp = await fetch(`${this.base}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`API ${resp.status} ${path}: ${body}`);
    }
    return resp.json();
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, { method: 'POST', body: JSON.stringify(body) });
  }

  private put<T>(path: string, body: unknown): Promise<T> {
    return this.request(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  // ── Novelas ────────────────────────────────────────────────────────────────

  listNovels(): Promise<Novel[]> {
    return this.request('/novels');
  }

  getNovels(novelId: number): Promise<Novel & { chapters: ChapterSummary[] }> {
    return this.request(`/novels/${novelId}`);
  }

  createNovel(payload: NovelCreatePayload): Promise<Novel> {
    return this.post('/novels', payload);
  }

  /**
   * Importa una novela completa con capítulos ya divididos.
   * El frontend extrae el contenido del .docx con mammoth y lo trocea por headings
   * antes de llamar a este método.
   */
  importNovel(payload: NovelImportPayload): Promise<Novel & { chapters: Chapter[] }> {
    return this.post('/novels/import', payload);
  }

  updateNovel(
    novelId: number,
    fields: Partial<Pick<Novel, 'title' | 'author' | 'description' | 'cover_color'>>,
  ): Promise<Novel> {
    return this.put(`/novels/${novelId}`, fields);
  }

  async deleteNovel(novelId: number): Promise<void> {
    await fetch(`${this.base}/novels/${novelId}`, { method: 'DELETE' });
  }

  // ── Capítulos ──────────────────────────────────────────────────────────────

  listChapters(novelId: number): Promise<ChapterSummary[]> {
    return this.request(`/novels/${novelId}/chapters`);
  }

  /**
   * Carga el capítulo completo (con contenido + anotaciones) y convierte
   * los start_offset/end_offset de BD al formato start/end que usa el editor.
   */
  async getChapter(novelId: number, chapterId: number): Promise<Chapter> {
    const raw: any = await this.request(`/novels/${novelId}/chapters/${chapterId}`);
    return {
      ...raw,
      has_summary: !!raw.has_summary,
      // Normalizamos las anotaciones para que sean consistentes con StoredAnnotation
      annotations: (raw.annotations ?? []).map((a: any) => ({
        ...a,
        metadata: a.metadata ?? {},
      })),
    };
  }

  createChapter(
    novelId: number,
    payload: { title: string; content_text?: string; content_html?: string },
  ): Promise<Chapter> {
    return this.post(`/novels/${novelId}/chapters`, payload);
  }

  /**
   * Guarda el estado del editor en la BD. Puede incluir anotaciones si se está
   * guardando el resultado de un análisis completo (rara vez necesario: los análisis
   * ya persisten automáticamente vía chapter_id en AnalyzeRequest).
   */
  saveChapter(novelId: number, chapterId: number, payload: ChapterUpdatePayload): Promise<Chapter> {
    return this.put(`/novels/${novelId}/chapters/${chapterId}`, payload);
  }

  reorderChapters(novelId: number, orderedIds: number[]): Promise<ChapterSummary[]> {
    return this.post(`/novels/${novelId}/chapters/reorder`, { ordered_ids: orderedIds });
  }

  async deleteChapter(novelId: number, chapterId: number): Promise<void> {
    await fetch(`${this.base}/novels/${novelId}/chapters/${chapterId}`, { method: 'DELETE' });
  }

  // ── Resumen LLM ────────────────────────────────────────────────────────────

  /**
   * Genera el resumen del capítulo via streaming SSE.
   * Llama a onToken con cada token a medida que llega y resuelve la promesa
   * con el resumen completo cuando el backend emite el evento 'done'.
   */
  async summarizeChapter(
    novelId: number,
    chapterId: number,
    onToken: (token: string) => void,
  ): Promise<string> {
    const resp = await fetch(`${this.base}/novels/${novelId}/chapters/${chapterId}/summarize`, {
      method: 'POST',
    });
    if (!resp.ok) throw new Error(`API ${resp.status}`);

    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const ev = JSON.parse(line.slice(6).trim());
          if (ev.type === 'token') onToken(ev.token);
          if (ev.type === 'done') return ev.summary as string;
          if (ev.type === 'error') throw new Error(ev.message);
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return '';
  }

  /**
   * Convierte las anotaciones almacenadas en BD (con start_offset/end_offset)
   * al formato TextAnnotation que usan el editor y los decoradores TipTap.
   */
  annotationsToEditor(chapter: Chapter): TextAnnotation[] {
    return chapter.annotations.map(toTextAnnotation);
  }
}
