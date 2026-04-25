import { Component, inject, OnDestroy, signal, ViewEncapsulation } from '@angular/core';
import { TiptapEditorDirective } from 'ngx-tiptap';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import * as mammoth from 'mammoth';

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

    try {
      const { fullText } = buildLLMContext(this.editor);
      const annotations = await this.annotationSvc.analyze(fullText);
      setAnnotations(this.editor, annotations);

      console.groupCollapsed(
        '%c[LLM Annotations]',
        'color:#a78bfa; font-weight:bold',
        `${annotations.length} anotaciones`,
      );
      console.table(
        annotations.map((a) => ({
          id: a.id,
          tipo: a.type,
          ini: a.start,
          fin: a.end,
          chars: a.end - a.start,
          texto: fullText.slice(a.start, a.end).slice(0, 50),
          meta: JSON.stringify(a.metadata ?? {}),
        })),
      );
      console.groupEnd();
    } catch (err) {
      this.errorMsg.set(`Error al analizar: ${err}`);
    } finally {
      this.isAnalyzing.set(false);
    }
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

    const from = annEl.getAttribute('data-ann-id') ? this.editor.state.selection.anchor : -1;

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
          '%cTexto antes de cualquier cambio:',
          'color:#94a3b8',
          original !== undefined ? `"${original}"` : '(párrafo nuevo, sin snapshot)',
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
