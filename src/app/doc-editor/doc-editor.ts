import { Component, inject, OnDestroy, signal, ViewEncapsulation } from '@angular/core';
import { TiptapEditorDirective } from 'ngx-tiptap';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import * as mammoth from 'mammoth';

import { ChunkLog, ChunkStatus, LiveAnnotation } from './chunk-log.types';
import {
  buildLLMContext,
  ChangeTrackerExtension,
  getModifiedCount,
  getTrackerState,
  LLMEditContext,
  TRACKER_KEY,
} from './change-tracker.extension';
import {
  AnnotationHighlightExtension,
  clearAnnotations,
  getAnnotationCount,
  getAnnotations,
  setAnnotations,
} from './annotation-highlight.extension';
import { LlmAnnotationService } from './llm-annotation.service';
import { AnnotationType, ANNOTATION_VISUAL, TextAnnotation } from './semantic-annotations.types';
import { DebugPanelComponent } from './debug-panel.component';

interface TooltipContent {
  label: string;
  detail?: string;
  border: string;
}

@Component({
  selector: 'app-doc-editor',
  standalone: true,
  imports: [TiptapEditorDirective, DebugPanelComponent],
  encapsulation: ViewEncapsulation.None,
  templateUrl: './doc-editor.html',
  styleUrl: './doc-editor.scss',
})
export class DocEditor implements OnDestroy {
  protected isLoading = signal(false);
  protected errorMsg = signal<string | null>(null);
  protected wordCount = signal(0);
  protected modifiedCount = signal(0);
  protected isEmpty = signal(true);
  protected isAnalyzing = signal(false);
  protected annotationCount = signal(0);
  protected xrayMode = signal(false);
  protected debugOpen = signal(false);
  protected tooltipVisible = signal(false);
  protected tooltipContent = signal<TooltipContent | null>(null);
  protected tooltipPos = signal({ x: 0, y: 0 });
  protected debugTick = signal(0);
  protected currentAnns = signal<TextAnnotation[]>([]);
  protected currentFullText = signal('');
  protected analyzeProgress = signal(0);

  /** Activa el modo reasoning del LLM (DeepSeek-R1, QwQ, etc.). */
  protected enableThinking = signal(false);
  protected chunkLogs = signal<ChunkLog[]>([]);

  protected readonly legendItems = (
    Object.entries(ANNOTATION_VISUAL) as [
      AnnotationType,
      (typeof ANNOTATION_VISUAL)[AnnotationType],
    ][]
  ).map(([type, v]) => ({ type, ...v }));

  private readonly annotationSvc = inject(LlmAnnotationService);
  private paragraphSnapshot = new Map<number, string>();
  private loggedParaIndices = new Set<number>();

  readonly editor = new Editor({
    extensions: [
      StarterKit.configure({ codeBlock: false, blockquote: false, horizontalRule: false }),
      ChangeTrackerExtension,
      AnnotationHighlightExtension,
    ],
    content: '',
    editorProps: {
      attributes: { class: 'tiptap-content', spellcheck: 'true' },
    },
    onTransaction: ({ editor, transaction }) => {
      this.wordCount.set(this.computeWordCount(editor));
      this.modifiedCount.set(getModifiedCount(editor));
      this.isEmpty.set(editor.isEmpty);
      this.annotationCount.set(getAnnotationCount(editor));
      this.currentAnns.set(getAnnotations(editor));
      this.currentFullText.set(buildLLMContext(editor).fullText);
      this.debugTick.set(this.debugTick() + 1);
      if (transaction.docChanged) {
        this.logFirstModifications(editor);
      }
    },
  });

  ngOnDestroy(): void {
    this.editor.destroy();
  }

  protected async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;
    const file = input.files[0];
    if (!file.name.endsWith('.docx')) {
      this.errorMsg.set('Formato inválido. Solo se aceptan archivos .docx');
      return;
    }
    this.isLoading.set(true);
    this.errorMsg.set(null);
    try {
      await this.loadDocx(file);
    } catch (err) {
      this.errorMsg.set(`Error al cargar el archivo: ${err}`);
    } finally {
      this.isLoading.set(false);
      input.value = '';
    }
  }

  private async loadDocx(file: File): Promise<void> {
    const arrayBuffer = await file.arrayBuffer();
    const { value: html, messages } = await mammoth.convertToHtml({ arrayBuffer });
    if (messages.length) console.warn('Advertencias mammoth:', messages);

    this.editor.commands.setContent(html, { emitUpdate: false });
    this.editor.view.dispatch(this.editor.state.tr.setMeta(TRACKER_KEY, { reset: true }));
    (this.editor.commands as any).clearHistory?.();
    clearAnnotations(this.editor);
    this.captureParaSnapshot();
    this.loggedParaIndices.clear();
    this.wordCount.set(this.computeWordCount(this.editor));
    this.modifiedCount.set(0);
    this.annotationCount.set(0);
    this.isEmpty.set(this.editor.isEmpty);

    const paraCount = this.paragraphSnapshot.size;
    console.groupCollapsed(
      '%c[Doc cargado]',
      'color:#60a5fa; font-weight:bold',
      `${file.name} · ${this.wordCount()} palabras · ${paraCount} párrafos`,
    );
    this.paragraphSnapshot.forEach((text, idx) => {
      console.log(`  Párrafo #${idx}:`, `"${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
    });
    console.groupEnd();
  }

  protected async analyze(): Promise<void> {
    if (this.editor.isEmpty || this.isAnalyzing()) return;

    this.isAnalyzing.set(true);
    this.errorMsg.set(null);
    this.analyzeProgress.set(0);
    this.chunkLogs.set([]);
    clearAnnotations(this.editor);

    const accumulated: LiveAnnotation[] = [];

    try {
      const { fullText } = buildLLMContext(this.editor);

      for await (const event of this.annotationSvc.analyzeStream(fullText, this.enableThinking())) {
        switch (event.type) {
          case 'start':
            console.log(
              `%c[LLM] Iniciando — ${event.total_chunks} chunks | thinking=${this.enableThinking()}`,
              'color:#a78bfa; font-weight:bold',
            );
            break;

          case 'chunk_start':
            this.chunkLogs.update((logs) => [
              ...logs,
              {
                index: event.chunk,
                total: event.total_chunks,
                preview: event.preview,
                inputText: event.inputText, // v5
                currentPass: null, // v5
                refsThinkContent: '', // v5
                refsXmlContent: '', // v5
                blocksThinkContent: '', // v5
                blocksXmlContent: '', // v5
                annotations: [],
                status: 'thinking' as ChunkStatus,
              },
            ]);
            this.analyzeProgress.set(Math.round((event.chunk / event.total_chunks) * 100));
            break;

          // v5: pasada nueva iniciada — actualizar currentPass
          case 'pass_start':
            this.chunkLogs.update((logs) =>
              this.patchLog(logs, event.chunk, (log) => ({
                ...log,
                currentPass: event.pass,
                status: 'thinking' as ChunkStatus,
              })),
            );
            break;

          case 'token':
            this.chunkLogs.update((logs) =>
              this.patchLog(logs, event.chunk, (log) => ({
                ...log,
                // v5: enrutar al campo correcto según la pasada
                refsXmlContent:
                  event.pass === 'refs' ? log.refsXmlContent + event.token : log.refsXmlContent,
                blocksXmlContent:
                  event.pass === 'blocks'
                    ? log.blocksXmlContent + event.token
                    : log.blocksXmlContent,
                status: 'generating' as ChunkStatus,
              })),
            );
            break;

          case 'think_token':
            this.chunkLogs.update((logs) =>
              this.patchLog(logs, event.chunk, (log) => ({
                ...log,
                // v5: enrutar al campo correcto según la pasada
                refsThinkContent:
                  event.pass === 'refs' ? log.refsThinkContent + event.token : log.refsThinkContent,
                blocksThinkContent:
                  event.pass === 'blocks'
                    ? log.blocksThinkContent + event.token
                    : log.blocksThinkContent,
                status: 'thinking' as ChunkStatus,
              })),
            );
            break;

          case 'progress': {
            const tagged: LiveAnnotation[] = event.annotations.map((a) => ({
              ...a,
              chunkIndex: event.chunk,
            }));
            if (tagged.length) {
              accumulated.push(...tagged);
              setAnnotations(this.editor, [...accumulated]);
            }
            this.chunkLogs.update((logs) =>
              this.patchLog(logs, event.chunk, (log) => ({
                ...log,
                annotations: tagged,
                status: 'done' as ChunkStatus,
                currentPass: null,
              })),
            );
            const pct = Math.round(((event.chunk + 1) / event.total_chunks) * 100);
            this.analyzeProgress.set(pct);
            break;
          }

          case 'error':
            console.warn(
              `%c[LLM] Error chunk ${event.chunk ?? '?'}: ${event.message}`,
              'color:#f87171',
            );
            this.chunkLogs.update((logs) =>
              this.patchLog(logs, event.chunk ?? -1, (log) => ({
                ...log,
                status: 'error' as ChunkStatus,
                errorMessage: event.message,
                currentPass: null,
              })),
            );
            break;

          case 'done':
            this.analyzeProgress.set(100);
            console.groupCollapsed(
              `%c[LLM Annotations] ${event.total_annotations} anotaciones`,
              'color:#a78bfa; font-weight:bold',
            );
            console.table(
              accumulated.map((a) => ({
                id: a.id,
                tipo: a.type,
                ini: a.start,
                fin: a.end,
                chars: a.end - a.start,
                chunk: a.chunkIndex,
                texto: fullText.slice(a.start, a.end).slice(0, 50),
              })),
            );
            console.groupEnd();
            break;
        }
      }
    } catch (err) {
      this.errorMsg.set(`Error al analizar: ${err}`);
    } finally {
      this.isAnalyzing.set(false);
      this.analyzeProgress.set(0);
    }
  }

  private patchLog(
    logs: ChunkLog[],
    chunkIndex: number,
    patch: (log: ChunkLog) => ChunkLog,
  ): ChunkLog[] {
    const updated = [...logs];
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].index === chunkIndex) {
        updated[i] = patch(updated[i]);
        return updated;
      }
    }
    return updated;
  }

  protected onClearAnnotations(): void {
    clearAnnotations(this.editor);
    this.annotationCount.set(0);
  }

  protected onEditorMouseOver(event: MouseEvent): void {
    const annEl = (event.target as HTMLElement).closest<HTMLElement>('.ann');
    if (!annEl) {
      this.tooltipVisible.set(false);
      return;
    }

    const type = annEl.dataset['annType'] as AnnotationType;
    const metaRaw = annEl.dataset['annMeta'];
    const meta = metaRaw ? JSON.parse(metaRaw) : null;
    const visual = ANNOTATION_VISUAL[type];
    const rect = annEl.getBoundingClientRect();

    this.tooltipContent.set({
      label: visual?.label ?? type,
      detail: meta?.['name'] ?? meta?.['location'] ?? undefined,
      border: visual?.border ?? '#888',
    });
    this.tooltipPos.set({ x: rect.left + rect.width / 2, y: rect.top });
    this.tooltipVisible.set(true);
  }

  protected onEditorMouseLeave(): void {
    this.tooltipVisible.set(false);
  }

  protected onEditorClick(event: MouseEvent): void {
    const annEl = (event.target as HTMLElement).closest<HTMLElement>('.ann');
    if (!annEl) return;

    const annId = annEl.dataset['annId'];
    const ann = this.currentAnns().find((a) => a.id === annId);
    if (!ann) return;

    const text = this.currentFullText().slice(ann.start, ann.end);
    const visual = ANNOTATION_VISUAL[ann.type as AnnotationType];

    console.group(
      `%c[Click] ${visual?.label ?? ann.type}`,
      `color:${visual?.border ?? '#a78bfa'}; font-weight:bold`,
    );
    console.log('id:      ', ann.id);
    console.log('tipo:    ', ann.type);
    console.log('texto:   ', `"${text}"`);
    console.log('offsets: ', `char ${ann.start} → ${ann.end}`);
    if (ann.metadata && Object.keys(ann.metadata).length) {
      console.log('metadata:', ann.metadata);
    }
    console.groupEnd();
  }

  getLLMContext(): LLMEditContext {
    return buildLLMContext(this.editor);
  }

  private logFirstModifications(editor: Editor): void {
    const tracker = getTrackerState(editor);
    if (!tracker) return;
    let paraIdx = 0;
    editor.state.doc.forEach((_, pmOffset) => {
      if (tracker.modifiedOffsets.has(pmOffset) && !this.loggedParaIndices.has(paraIdx)) {
        this.loggedParaIndices.add(paraIdx);
        const original = this.paragraphSnapshot.get(paraIdx);
        console.groupCollapsed(
          `%c[ORIGINAL] Párrafo #${paraIdx} — primera edición`,
          'color:#f59e0b; font-weight:bold',
        );
        console.log(
          '%cTexto antes:',
          'color:#94a3b8',
          original !== undefined ? `"${original}"` : '(párrafo nuevo)',
        );
        console.log('Índice de párrafo:', paraIdx, '| PM offset actual:', pmOffset);
        console.groupEnd();
      }
      paraIdx++;
    });
  }

  private captureParaSnapshot(): void {
    this.paragraphSnapshot.clear();
    let idx = 0;
    this.editor.state.doc.forEach((node) => {
      this.paragraphSnapshot.set(idx++, node.textContent);
    });
  }

  private computeWordCount(editor: Editor): number {
    const text = editor.state.doc.textContent.trim();
    return text ? text.split(/\s+/).length : 0;
  }
}
