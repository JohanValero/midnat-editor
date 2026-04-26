import { Injectable } from '@angular/core';
import { TextAnnotation } from './semantic-annotations.types';

// ── Protocolo SSE ─────────────────────────────────────────────────────────────

export interface SseStartEvent {
  type: 'start';
  total_chunks: number;
}

export interface SseChunkStartEvent {
  type: 'chunk_start';
  chunk: number;
  total_chunks: number;
  preview: string;
  /** v5: texto completo del chunk para el panel de debug. */
  inputText: string;
}

/** v5: señala el inicio de una pasada LLM. */
export interface SsePassStartEvent {
  type: 'pass_start';
  chunk: number;
  pass: 'refs' | 'blocks';
}

/** Token de razonamiento interno del modelo. */
export interface SseThinkTokenEvent {
  type: 'think_token';
  chunk: number;
  token: string;
  /** v5: identifica de qué pasada procede. */
  pass: 'refs' | 'blocks';
}

/** Token XML real generado por el modelo. */
export interface SseTokenEvent {
  type: 'token';
  chunk: number;
  token: string;
  /** v5: identifica de qué pasada procede. */
  pass: 'refs' | 'blocks';
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
  | SsePassStartEvent
  | SseThinkTokenEvent
  | SseTokenEvent
  | SseProgressEvent
  | SseErrorEvent
  | SseDoneEvent;

// ─────────────────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class LlmAnnotationService {
  readonly baseUrl = 'http://localhost:8000';

  async *analyzeStream(fullText: string, enableThinking = false): AsyncGenerator<SseEvent> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fullText, enable_thinking: enableThinking }),
      });
    } catch (err) {
      throw new Error(`No se pudo conectar con el backend (${this.baseUrl}): ${err}`);
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

  /** Compatibilidad hacia atrás. */
  async analyze(fullText: string): Promise<TextAnnotation[]> {
    const all: TextAnnotation[] = [];
    for await (const ev of this.analyzeStream(fullText)) {
      if (ev.type === 'progress' && ev.annotations?.length) {
        all.push(...ev.annotations);
      }
    }
    return all;
  }
}
