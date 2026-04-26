import { Injectable } from '@angular/core';
import { TextAnnotation } from './semantic-annotations.types';
import { AnalysisType } from './chunk-log.types';

// ── Protocolo SSE ─────────────────────────────────────────────────────────────
// En v6 cada endpoint es una sola pasada, así que los eventos de token
// ya no necesitan un campo `pass`. El cliente sabe qué pasada es porque
// llamó a un método específico (analyzeRefsStream, etc.).

export interface SseStartEvent {
  type: 'start';
  total_chunks: number;
}

export interface SseChunkStartEvent {
  type: 'chunk_start';
  chunk: number;
  total_chunks: number;
  preview: string;
  inputText: string;
}

export interface SseThinkTokenEvent {
  type: 'think_token';
  chunk: number;
  token: string;
}

export interface SseTokenEvent {
  type: 'token';
  chunk: number;
  token: string;
}

export interface SseProgressEvent {
  type: 'progress';
  chunk: number;
  total_chunks: number;
  annotations: TextAnnotation[];
}

export interface SseErrorEvent {
  type: 'error';
  chunk?: number;
  message: string;
}

export interface SseDoneEvent {
  type: 'done';
  total_annotations: number;
}

export type SseEvent =
  | SseStartEvent
  | SseChunkStartEvent
  | SseThinkTokenEvent
  | SseTokenEvent
  | SseProgressEvent
  | SseErrorEvent
  | SseDoneEvent;

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class LlmAnnotationService {
  readonly baseUrl = 'http://localhost:8000';

  // ── Métodos públicos por endpoint ─────────────────────────────────────────

  /** Extrae referencias: personajes, lugares y objetos narrativos. */
  analyzeRefsStream(fullText: string, enableThinking = false, chapterId?: number) {
    return this._stream('/analyze/refs', fullText, enableThinking, chapterId);
  }

  /**
   * Clasifica la estructura narrativa: narración, pensamientos, títulos, cortes.
   * Las líneas de diálogo puro son ignoradas por este endpoint.
   */
  analyzeBlocksStream(
    fullText: string,
    enableThinking = false,
    chapterId?: number,
  ): AsyncGenerator<SseEvent> {
    return this._stream('/analyze/blocks', fullText, enableThinking, chapterId);
  }

  /**
   * Clasifica conversaciones: diálogo y atribuciones narrativas.
   * Recomendado ejecutar después de analyzeBlocksStream para tener contexto de escenas,
   * aunque funciona de forma independiente.
   */
  analyzeConversationsStream(
    fullText: string,
    enableThinking = false,
    chapterId?: number,
  ): AsyncGenerator<SseEvent> {
    return this._stream('/analyze/conversations', fullText, enableThinking, chapterId);
  }

  // ── Implementación base compartida ────────────────────────────────────────

  private async *_stream(
    path: string,
    fullText: string,
    enableThinking: boolean,
    chapterId?: number,
  ): AsyncGenerator<SseEvent> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullText,
          enable_thinking: enableThinking,
          chapter_id: chapterId ?? null,
        }),
      });
    } catch (err) {
      throw new Error(`No se pudo conectar con el backend (${this.baseUrl}${path}): ${err}`);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`API ${response.status}: ${body}`);
    }

    const reader = response.body!.getReader();
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
          const raw = line.slice(6).trim();
          if (!raw) continue;

          let event: SseEvent;
          try {
            event = JSON.parse(raw) as SseEvent;
          } catch {
            console.warn('[SSE] JSON inválido:', raw.slice(0, 80));
            continue;
          }

          yield event;
          if (event.type === 'done') return;
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  /**
   * Ejecuta los tres análisis en secuencia y acumula todas las anotaciones.
   * Útil para análisis completo de un documento.
   */
  async analyzeAll(fullText: string, enableThinking = false): Promise<TextAnnotation[]> {
    const all: TextAnnotation[] = [];
    const streams: [AnalysisType, AsyncGenerator<SseEvent>][] = [
      ['refs', this.analyzeRefsStream(fullText, enableThinking)],
      ['blocks', this.analyzeBlocksStream(fullText, enableThinking)],
      ['conversations', this.analyzeConversationsStream(fullText, enableThinking)],
    ];

    for (const [, stream] of streams) {
      for await (const ev of stream) {
        if (ev.type === 'progress' && ev.annotations?.length) {
          all.push(...ev.annotations);
        }
      }
    }
    return all;
  }
}
