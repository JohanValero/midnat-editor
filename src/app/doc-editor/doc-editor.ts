import {
  Component,
  computed,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  EventEmitter,
  signal,
  SimpleChanges,
  ViewEncapsulation,
} from '@angular/core';
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
import { NovelApiService } from './novel-api.service';
import { AnnotationType, ANNOTATION_VISUAL, TextAnnotation } from './semantic-annotations.types';
import { Chapter, Novel } from './novel.types';
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
export class DocEditor implements OnChanges, OnDestroy {
  // ── Contexto de capítulo (puede ser null cuando se usa sin BD) ─────────────
  @Input() novel: Novel | null = null;
  @Input() chapter: Chapter | null = null;

  /** Emitido cuando el usuario quiere volver a la biblioteca. */
  @Output() backToLibrary = new EventEmitter<void>();

  // ── Estado del editor ──────────────────────────────────────────────────────
  protected isLoading = signal(false);
  protected errorMsg = signal<string | null>(null);
  protected wordCount = signal(0);
  protected modifiedCount = signal(0);
  protected isEmpty = signal(true);
  protected isAnalyzingRefs = signal(false);
  protected isAnalyzingBlocks = signal(false);
  protected isAnalyzingConversations = signal(false);
  protected progressRefs = signal(0);
  protected progressBlocks = signal(0);
  protected progressConversations = signal(0);
  protected annotationCount = signal(0);
  protected xrayMode = signal(false);
  protected debugOpen = signal(false);
  protected tooltipVisible = signal(false);
  protected tooltipContent = signal<TooltipContent | null>(null);
  protected tooltipPos = signal({ x: 0, y: 0 });
  protected debugTick = signal(0);
  protected currentAnns = signal<TextAnnotation[]>([]);
  protected currentFullText = signal('');
  protected enableThinking = signal(false);
  protected chunkLogs = signal<ChunkLog[]>([]);

  // ── Guardar ────────────────────────────────────────────────────────────────
  protected isSaving = signal(false);
  protected saveSuccess = signal(false); // muestra checkmark por 2 s

  // ── Resumen ────────────────────────────────────────────────────────────────
  protected summaryText = signal('');
  protected isSummarizing = signal(false);
  protected showSummaryPanel = signal(false);

  protected readonly isAnalyzing = computed(
    () => this.isAnalyzingRefs() || this.isAnalyzingBlocks() || this.isAnalyzingConversations(),
  );
  protected readonly analyzeProgress = computed(() => {
    if (this.isAnalyzingRefs()) return this.progressRefs();
    if (this.isAnalyzingBlocks()) return this.progressBlocks();
    if (this.isAnalyzingConversations()) return this.progressConversations();
    return 0;
  });

  protected readonly legendItems = (
    Object.entries(ANNOTATION_VISUAL) as [
      AnnotationType,
      (typeof ANNOTATION_VISUAL)[AnnotationType],
    ][]
  ).map(([type, v]) => ({ type, ...v }));

  private readonly annotationSvc = inject(LlmAnnotationService);
  private readonly novelApi = inject(NovelApiService);
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
    editorProps: { attributes: { class: 'tiptap-content', spellcheck: 'true' } },
    onTransaction: ({ editor, transaction }) => {
      this.wordCount.set(this.computeWordCount(editor));
      this.modifiedCount.set(getModifiedCount(editor));
      this.isEmpty.set(editor.isEmpty);
      this.annotationCount.set(getAnnotationCount(editor));
      this.currentAnns.set(getAnnotations(editor));
      this.currentFullText.set(buildLLMContext(editor).fullText);
      this.debugTick.set(this.debugTick() + 1);
      if (transaction.docChanged) this.logFirstModifications(editor);
    },
  });

  // ── Ciclo de vida ──────────────────────────────────────────────────────────

  ngOnChanges(changes: SimpleChanges): void {
    // Cada vez que el capítulo cambia (el usuario abre otro),
    // recargamos el editor con el nuevo contenido y anotaciones.
    if (changes['chapter'] && this.chapter) {
      this.loadChapter(this.chapter);
    }
  }

  ngOnDestroy(): void {
    this.editor.destroy();
  }

  /**
   * Carga el contenido HTML del capítulo en TipTap y restaura sus anotaciones.
   * Resetea el tracker de cambios para que `modifiedCount` empiece en 0.
   */
  private loadChapter(chapter: Chapter): void {
    const html = chapter.content_html || '';
    this.editor.commands.setContent(html, { emitUpdate: false });
    this.editor.view.dispatch(this.editor.state.tr.setMeta(TRACKER_KEY, { reset: true }));
    (this.editor.commands as any).clearHistory?.();

    this.accumulated = [];
    clearAnnotations(this.editor);
    this.chunkLogs.set([]);
    this.summaryText.set(chapter.summary || '');

    // Convertimos las anotaciones almacenadas (start_offset/end_offset)
    // al formato TextAnnotation (start/end) que usa el editor.
    const anns = this.novelApi.annotationsToEditor(chapter);
    if (anns.length) {
      setAnnotations(this.editor, anns);
      // Las incorporamos al acumulador para que los análisis siguientes las sumen
      this.accumulated = anns.map((a) => ({
        ...a,
        chunkIndex: -1,
        analysisType: 'refs' as AnalysisType,
      }));
    }

    this.captureParaSnapshot();
    this.loggedParaIndices.clear();
    this.wordCount.set(this.computeWordCount(this.editor));
    this.modifiedCount.set(0);
    this.annotationCount.set(getAnnotationCount(this.editor));
    this.isEmpty.set(this.editor.isEmpty);
  }

  // ── Importar .docx (modo standalone, sin novela en BD) ────────────────────

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
      const ab = await file.arrayBuffer();
      const { value: html, messages } = await mammoth.convertToHtml({ arrayBuffer: ab });
      if (messages.length) console.warn('Mammoth:', messages);
      this.editor.commands.setContent(html, { emitUpdate: false });
      this.editor.view.dispatch(this.editor.state.tr.setMeta(TRACKER_KEY, { reset: true }));
      this.accumulated = [];
      clearAnnotations(this.editor);
      this.captureParaSnapshot();
      this.loggedParaIndices.clear();
      this.wordCount.set(this.computeWordCount(this.editor));
    } catch (err) {
      this.errorMsg.set(`Error al cargar: ${err}`);
    } finally {
      this.isLoading.set(false);
      input.value = '';
    }
  }

  // ── Guardar en BD ──────────────────────────────────────────────────────────

  protected async saveChapter(): Promise<void> {
    if (!this.novel || !this.chapter || this.isSaving()) return;

    this.isSaving.set(true);
    this.errorMsg.set(null);

    try {
      const ctx = buildLLMContext(this.editor);
      const contentHtml = this.editor.getHTML();
      const contentText = ctx.fullText;

      await this.novelApi.saveChapter(this.novel.id, this.chapter.id, {
        content_html: contentHtml,
        content_text: contentText,
      });

      // Resetea el tracker de cambios
      this.editor.view.dispatch(this.editor.state.tr.setMeta(TRACKER_KEY, { reset: true }));
      this.modifiedCount.set(0);

      // Feedback visual: checkmark por 2 segundos
      this.saveSuccess.set(true);
      setTimeout(() => this.saveSuccess.set(false), 2000);

      console.log(
        `%c[Guardado] Capítulo ${this.chapter.id} — ${contentText.split(/\s+/).length} palabras`,
        'color:#34d399; font-weight:bold',
      );
    } catch (err) {
      this.errorMsg.set(`Error guardando: ${err}`);
    } finally {
      this.isSaving.set(false);
    }
  }

  // ── Resumen LLM ────────────────────────────────────────────────────────────

  protected async generateSummary(): Promise<void> {
    if (!this.novel || !this.chapter || this.isSummarizing()) return;

    this.isSummarizing.set(true);
    this.summaryText.set('');
    this.showSummaryPanel.set(true);

    try {
      const summary = await this.novelApi.summarizeChapter(
        this.novel.id,
        this.chapter.id,
        (token) => this.summaryText.update((s) => s + token),
      );
      this.summaryText.set(summary);
    } catch (err) {
      this.errorMsg.set(`Error generando resumen: ${err}`);
    } finally {
      this.isSummarizing.set(false);
    }
  }

  // ── Análisis ───────────────────────────────────────────────────────────────

  protected async analyzeRefs(): Promise<void> {
    if (this.editor.isEmpty || this.isAnalyzing()) return;
    await this._runAnalysis('refs', this.isAnalyzingRefs, this.progressRefs, (ft) =>
      this.annotationSvc.analyzeRefsStream(
        ft,
        this.enableThinking(),
        this.chapter?.id ?? undefined,
      ),
    );
  }

  protected async analyzeBlocks(): Promise<void> {
    if (this.editor.isEmpty || this.isAnalyzing()) return;
    await this._runAnalysis('blocks', this.isAnalyzingBlocks, this.progressBlocks, (ft) =>
      this.annotationSvc.analyzeBlocksStream(
        ft,
        this.enableThinking(),
        this.chapter?.id ?? undefined,
      ),
    );
  }

  protected async analyzeConversations(): Promise<void> {
    if (this.editor.isEmpty || this.isAnalyzing()) return;
    await this._runAnalysis(
      'conversations',
      this.isAnalyzingConversations,
      this.progressConversations,
      (ft) =>
        this.annotationSvc.analyzeConversationsStream(
          ft,
          this.enableThinking(),
          this.chapter?.id ?? undefined,
        ),
    );
  }

  private async _runAnalysis(
    analysisType: AnalysisType,
    isAnalyzingSignal: ReturnType<typeof signal<boolean>>,
    progressSignal: ReturnType<typeof signal<number>>,
    streamFn: (ft: string) => AsyncGenerator<SseEvent>,
  ): Promise<void> {
    isAnalyzingSignal.set(true);
    this.errorMsg.set(null);
    progressSignal.set(0);

    const { fullText } = buildLLMContext(this.editor);
    const thisRun: LiveAnnotation[] = [];

    try {
      for await (const event of streamFn(fullText)) {
        switch (event.type) {
          case 'start':
            console.log(
              `%c[LLM/${analysisType}] ${event.total_chunks} chunks`,
              'color:#a78bfa;font-weight:bold',
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
              this._patchLog(logs, event.chunk, analysisType, (l) => ({
                ...l,
                xmlContent: l.xmlContent + event.token,
                status: 'generating' as ChunkStatus,
              })),
            );
            break;
          case 'think_token':
            this.chunkLogs.update((logs) =>
              this._patchLog(logs, event.chunk, analysisType, (l) => ({
                ...l,
                thinkContent: l.thinkContent + event.token,
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
              thisRun.push(...tagged);
              setAnnotations(this.editor, [...this.accumulated, ...thisRun]);
            }
            this.chunkLogs.update((logs) =>
              this._patchLog(logs, event.chunk, analysisType, (l) => ({
                ...l,
                annotations: tagged,
                status: 'done' as ChunkStatus,
              })),
            );
            progressSignal.set(Math.round(((event.chunk + 1) / event.total_chunks) * 100));
            break;
          }
          case 'error':
            this.chunkLogs.update((logs) =>
              this._patchLog(logs, event.chunk ?? -1, analysisType, (l) => ({
                ...l,
                status: 'error' as ChunkStatus,
                errorMessage: event.message,
              })),
            );
            break;
          case 'done':
            progressSignal.set(100);
            break;
        }
      }
      this.accumulated.push(...thisRun);
    } catch (err) {
      this.errorMsg.set(`Error [${analysisType}]: ${err}`);
    } finally {
      isAnalyzingSignal.set(false);
      progressSignal.set(0);
    }
  }

  private _patchLog(
    logs: ChunkLog[],
    chunkIndex: number,
    analysisType: AnalysisType,
    patch: (l: ChunkLog) => ChunkLog,
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

  // ── Limpieza ───────────────────────────────────────────────────────────────

  protected onClearAnnotations(): void {
    this.accumulated = [];
    clearAnnotations(this.editor);
    this.annotationCount.set(0);
    this.chunkLogs.set([]);
  }

  // ── Tooltip / eventos ──────────────────────────────────────────────────────

  protected onEditorMouseOver(event: MouseEvent): void {
    const el = (event.target as HTMLElement).closest<HTMLElement>('.ann');
    if (!el) {
      this.tooltipVisible.set(false);
      return;
    }
    const type = el.dataset['annType'] as AnnotationType;
    const meta = el.dataset['annMeta'] ? JSON.parse(el.dataset['annMeta']) : null;
    const visual = ANNOTATION_VISUAL[type];
    const rect = el.getBoundingClientRect();
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
    const el = (event.target as HTMLElement).closest<HTMLElement>('.ann');
    if (!el) return;
    const annId = el.dataset['annId'];
    const ann = this.currentAnns().find((a) => a.id === annId);
    if (!ann) return;
    const text = this.currentFullText().slice(ann.start, ann.end);
    const visual = ANNOTATION_VISUAL[ann.type as AnnotationType];
    console.group(
      `%c[Click] ${visual?.label ?? ann.type}`,
      `color:${visual?.border};font-weight:bold`,
    );
    console.log('texto:', `"${text}"`);
    console.log('offsets:', `${ann.start}→${ann.end}`);
    if (ann.metadata && Object.keys(ann.metadata).length) console.log('metadata:', ann.metadata);
    console.groupEnd();
  }

  getLLMContext(): LLMEditContext {
    return buildLLMContext(this.editor);
  }

  private logFirstModifications(editor: any): void {
    const tracker = getTrackerState(editor);
    if (!tracker) return;
    let pi = 0;
    editor.state.doc.forEach((_: any, offset: number) => {
      if (tracker.modifiedOffsets.has(offset) && !this.loggedParaIndices.has(pi)) {
        this.loggedParaIndices.add(pi);
        console.groupCollapsed(`%c[ORIGINAL] Párrafo #${pi}`, 'color:#f59e0b;font-weight:bold');
        console.log('Antes:', this.paragraphSnapshot.get(pi) ?? '(nuevo)');
        console.groupEnd();
      }
      pi++;
    });
  }

  private captureParaSnapshot(): void {
    this.paragraphSnapshot.clear();
    let i = 0;
    this.editor.state.doc.forEach((n: any) => this.paragraphSnapshot.set(i++, n.textContent));
  }

  private computeWordCount(editor: any): number {
    const t = editor.state.doc.textContent.trim();
    return t ? t.split(/\s+/).length : 0;
  }
}
