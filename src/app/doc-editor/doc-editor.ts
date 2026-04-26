import { Component, computed, inject, OnDestroy, signal, ViewEncapsulation } from '@angular/core';
import { TiptapEditorDirective } from 'ngx-tiptap';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import * as mammoth from 'mammoth';

import { AnalysisType, ChunkLog, ChunkStatus, LiveAnnotation } from './chunk-log.types';
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
import { LlmAnnotationService, SseEvent } from './llm-annotation.service';
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
  protected annotationCount = signal(0);
  protected xrayMode = signal(false);
  protected debugOpen = signal(false);
  protected tooltipVisible = signal(false);
  protected tooltipContent = signal<TooltipContent | null>(null);
  protected tooltipPos = signal({ x: 0, y: 0 });
  protected debugTick = signal(0);
  protected currentAnns = signal<TextAnnotation[]>([]);
  protected currentFullText = signal('');

  // ── Estado de cada análisis ─────────────────────────────────────────────────
  protected isAnalyzingRefs = signal(false);
  protected isAnalyzingBlocks = signal(false);
  protected isAnalyzingConversations = signal(false);
  protected progressRefs = signal(0);
  protected progressBlocks = signal(0);
  protected progressConversations = signal(0);

  /** True si cualquiera de los tres análisis está en curso. */
  protected readonly isAnalyzing = computed(
    () => this.isAnalyzingRefs() || this.isAnalyzingBlocks() || this.isAnalyzingConversations(),
  );

  /** Progreso del análisis activo (0–100). Muestra el primero que esté activo. */
  protected readonly analyzeProgress = computed(() => {
    if (this.isAnalyzingRefs()) return this.progressRefs();
    if (this.isAnalyzingBlocks()) return this.progressBlocks();
    if (this.isAnalyzingConversations()) return this.progressConversations();
    return 0;
  });

  /** Activa el modo reasoning del LLM (DeepSeek-R1, QwQ, etc.). */
  protected enableThinking = signal(false);

  /**
   * Todos los ChunkLogs de los tres análisis, ordenados cronológicamente.
   * Cada log lleva su `analysisType` para que el panel de debug los diferencie.
   */
  protected chunkLogs = signal<ChunkLog[]>([]);

  protected readonly legendItems = (
    Object.entries(ANNOTATION_VISUAL) as [
      AnnotationType,
      (typeof ANNOTATION_VISUAL)[AnnotationType],
    ][]
  ).map(([type, v]) => ({ type, ...v }));

  private readonly annotationSvc = inject(LlmAnnotationService);

  /**
   * Acumula las anotaciones de los tres análisis.
   * Cada análisis añade las suyas y llama a setAnnotations() con el array completo,
   * de modo que el editor siempre muestra la unión de todos los análisis ejecutados.
   */
  private accumulated: LiveAnnotation[] = [];

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

  // ── Carga de archivo ────────────────────────────────────────────────────────

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

    // Al cargar un documento nuevo, limpiamos todas las anotaciones acumuladas
    this.accumulated = [];
    clearAnnotations(this.editor);
    this.chunkLogs.set([]);
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

  // ── Análisis 1: Referencias ─────────────────────────────────────────────────

  protected async analyzeRefs(): Promise<void> {
    if (this.editor.isEmpty || this.isAnalyzing()) return;
    await this._runAnalysis('refs', this.isAnalyzingRefs, this.progressRefs, (ft) =>
      this.annotationSvc.analyzeRefsStream(ft, this.enableThinking()),
    );
  }

  // ── Análisis 2: Estructura narrativa ────────────────────────────────────────

  protected async analyzeBlocks(): Promise<void> {
    if (this.editor.isEmpty || this.isAnalyzing()) return;
    await this._runAnalysis('blocks', this.isAnalyzingBlocks, this.progressBlocks, (ft) =>
      this.annotationSvc.analyzeBlocksStream(ft, this.enableThinking()),
    );
  }

  // ── Análisis 3: Conversaciones ──────────────────────────────────────────────

  protected async analyzeConversations(): Promise<void> {
    if (this.editor.isEmpty || this.isAnalyzing()) return;
    await this._runAnalysis(
      'conversations',
      this.isAnalyzingConversations,
      this.progressConversations,
      (ft) => this.annotationSvc.analyzeConversationsStream(ft, this.enableThinking()),
    );
  }

  // ── Lógica de ejecución compartida ─────────────────────────────────────────

  /**
   * Gestiona el ciclo de vida completo de un análisis:
   *  1. Activa la señal de carga correspondiente
   *  2. Itera el stream SSE y actualiza chunkLogs en tiempo real
   *  3. Acumula las anotaciones resultantes junto a las de análisis anteriores
   *  4. Actualiza el editor con el conjunto completo de anotaciones
   *
   * El parámetro `analysisType` sirve para taggear los ChunkLogs y las
   * LiveAnnotations, permitiendo al panel de debug diferenciar su origen.
   */
  private async _runAnalysis(
    analysisType: AnalysisType,
    isAnalyzingSignal: ReturnType<typeof signal<boolean>>,
    progressSignal: ReturnType<typeof signal<number>>,
    streamFn: (fullText: string) => AsyncGenerator<SseEvent>,
  ): Promise<void> {
    isAnalyzingSignal.set(true);
    this.errorMsg.set(null);
    progressSignal.set(0);

    const { fullText } = buildLLMContext(this.editor);

    // Las anotaciones de este análisis se añaden al acumulador global
    const thisRunAnnotations: LiveAnnotation[] = [];

    try {
      for await (const event of streamFn(fullText)) {
        switch (event.type) {
          case 'start':
            console.log(
              `%c[LLM/${analysisType}] Iniciando — ${event.total_chunks} chunks`,
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
                inputText: event.inputText,
                analysisType,
                thinkContent: '',
                xmlContent: '',
                annotations: [],
                status: 'thinking' as ChunkStatus,
              },
            ]);
            progressSignal.set(Math.round((event.chunk / event.total_chunks) * 100));
            break;

          case 'token':
            this.chunkLogs.update((logs) =>
              this._patchLog(logs, event.chunk, analysisType, (log) => ({
                ...log,
                xmlContent: log.xmlContent + event.token,
                status: 'generating' as ChunkStatus,
              })),
            );
            break;

          case 'think_token':
            this.chunkLogs.update((logs) =>
              this._patchLog(logs, event.chunk, analysisType, (log) => ({
                ...log,
                thinkContent: log.thinkContent + event.token,
                status: 'thinking' as ChunkStatus,
              })),
            );
            break;

          case 'progress': {
            const tagged: LiveAnnotation[] = event.annotations.map((a) => ({
              ...a,
              chunkIndex: event.chunk,
              analysisType,
            }));
            if (tagged.length) {
              thisRunAnnotations.push(...tagged);
              // Mostramos en el editor las anotaciones anteriores + las nuevas
              setAnnotations(this.editor, [...this.accumulated, ...thisRunAnnotations]);
            }
            this.chunkLogs.update((logs) =>
              this._patchLog(logs, event.chunk, analysisType, (log) => ({
                ...log,
                annotations: tagged,
                status: 'done' as ChunkStatus,
              })),
            );
            progressSignal.set(Math.round(((event.chunk + 1) / event.total_chunks) * 100));
            break;
          }

          case 'error':
            console.warn(
              `%c[LLM/${analysisType}] Error chunk ${event.chunk ?? '?'}: ${event.message}`,
              'color:#f87171',
            );
            this.chunkLogs.update((logs) =>
              this._patchLog(logs, event.chunk ?? -1, analysisType, (log) => ({
                ...log,
                status: 'error' as ChunkStatus,
                errorMessage: event.message,
              })),
            );
            break;

          case 'done':
            progressSignal.set(100);
            console.groupCollapsed(
              `%c[LLM/${analysisType}] ${event.total_annotations} anotaciones`,
              'color:#a78bfa; font-weight:bold',
            );
            console.table(
              thisRunAnnotations.map((a) => ({
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

      // Una vez terminado el análisis, consolida sus anotaciones en el acumulador
      this.accumulated.push(...thisRunAnnotations);
    } catch (err) {
      this.errorMsg.set(`Error al analizar [${analysisType}]: ${err}`);
    } finally {
      isAnalyzingSignal.set(false);
      progressSignal.set(0);
    }
  }

  /**
   * Localiza el ChunkLog más reciente que coincida con chunk+analysisType y lo parchea.
   * Usamos analysisType además del índice porque pueden convivir logs de distintos
   * análisis con el mismo chunk.index (cada análisis recorre todos los chunks).
   */
  private _patchLog(
    logs: ChunkLog[],
    chunkIndex: number,
    analysisType: AnalysisType,
    patch: (log: ChunkLog) => ChunkLog,
  ): ChunkLog[] {
    const updated = [...logs];
    for (let i = updated.length - 1; i >= 0; i--) {
      if (updated[i].index === chunkIndex && updated[i].analysisType === analysisType) {
        updated[i] = patch(updated[i]);
        return updated;
      }
    }
    return updated;
  }

  // ── Limpieza ────────────────────────────────────────────────────────────────

  protected onClearAnnotations(): void {
    this.accumulated = [];
    clearAnnotations(this.editor);
    this.annotationCount.set(0);
    this.chunkLogs.set([]);
  }

  // ── Tooltip y eventos de editor ─────────────────────────────────────────────

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
      detail: meta?.['name'] ?? meta?.['location'] ?? meta?.['object'] ?? undefined,
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
    if (ann.metadata && Object.keys(ann.metadata).length) console.log('metadata:', ann.metadata);
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
