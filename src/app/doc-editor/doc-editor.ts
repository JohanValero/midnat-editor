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

// ─── Tipos de UI internos ─────────────────────────────────────────────────────

interface TooltipContent {
  label: string;
  detail?: string;
  border: string;
}

// ─── Componente ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-doc-editor',
  standalone: true,
  imports: [TiptapEditorDirective, DebugPanelComponent],
  encapsulation: ViewEncapsulation.None,
  templateUrl: './doc-editor.html',
  styleUrl: './doc-editor.scss',
})
export class DocEditor implements OnDestroy {
  // ── Signals de estado del documento ──────────────────────────────────────
  protected isLoading = signal(false);
  protected errorMsg = signal<string | null>(null);
  protected wordCount = signal(0);
  protected modifiedCount = signal(0);
  protected isEmpty = signal(true);
  protected isAnalyzing = signal(false);
  protected annotationCount = signal(0);

  // ── Signals de modo de visualización ─────────────────────────────────────
  protected xrayMode = signal(false); // X-ray: colores fuertes + chips de tipo
  protected debugOpen = signal(false); // Panel de debug flotante

  // ── Signals para el tooltip ───────────────────────────────────────────────
  protected tooltipVisible = signal(false);
  protected tooltipContent = signal<TooltipContent | null>(null);
  protected tooltipPos = signal({ x: 0, y: 0 });

  // ── Datos que el debug panel necesita actualizados en cada transacción ────
  protected debugTick = signal(0);
  protected currentAnns = signal<TextAnnotation[]>([]);
  protected currentFullText = signal('');

  // ── Leyenda ───────────────────────────────────────────────────────────────
  protected readonly legendItems = (
    Object.entries(ANNOTATION_VISUAL) as [
      AnnotationType,
      (typeof ANNOTATION_VISUAL)[AnnotationType],
    ][]
  ).map(([type, v]) => ({ type, ...v }));

  // ── Servicio ──────────────────────────────────────────────────────────────
  private readonly annotationSvc = inject(LlmAnnotationService);

  // ── Snapshot de párrafos (para el logger de "línea original") ─────────────
  //
  // Al cargar un documento capturamos el texto de cada párrafo indexado por
  // su posición en el array (no por PM offset, que puede cambiar al editar).
  // Cuando una línea se modifica por primera vez, buscamos su índice actual
  // en el documento y sacamos el texto original de este mapa.
  private paragraphSnapshot = new Map<number, string>(); // index → texto original
  private loggedParaIndices = new Set<number>(); // índices ya logueados

  // ── Editor TipTap ─────────────────────────────────────────────────────────
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
      // ── Actualización de signals estándar ────────────────────────────────
      this.wordCount.set(this.computeWordCount(editor));
      this.modifiedCount.set(getModifiedCount(editor));
      this.isEmpty.set(editor.isEmpty);
      this.annotationCount.set(getAnnotationCount(editor));

      // ── Datos para el debug panel ────────────────────────────────────────
      this.currentAnns.set(getAnnotations(editor));
      this.currentFullText.set(buildLLMContext(editor).fullText);
      this.debugTick.set(this.debugTick() + 1);

      // ── Logger de "línea original" ───────────────────────────────────────
      // Solo actuamos cuando el documento realmente cambia para evitar
      // detectar falsas primeras modificaciones en movimientos de cursor.
      if (transaction.docChanged) {
        this.logFirstModifications(editor);
      }
    },
  });

  ngOnDestroy(): void {
    this.editor.destroy();
  }

  // ─── Carga de archivo ─────────────────────────────────────────────────────

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

    // Capturamos el snapshot DESPUÉS de que el contenido esté en el editor
    this.captureParaSnapshot();
    this.loggedParaIndices.clear();

    this.wordCount.set(this.computeWordCount(this.editor));
    this.modifiedCount.set(0);
    this.annotationCount.set(0);
    this.isEmpty.set(this.editor.isEmpty);

    // ── Console: resumen de carga ────────────────────────────────────────
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

  // ─── Análisis semántico ───────────────────────────────────────────────────

  protected async analyze(): Promise<void> {
    if (this.editor.isEmpty || this.isAnalyzing()) return;

    this.isAnalyzing.set(true);
    this.errorMsg.set(null);

    try {
      const { fullText } = buildLLMContext(this.editor);
      const annotations = await this.annotationSvc.analyze(fullText);
      setAnnotations(this.editor, annotations);

      // ── Console: tabla de resultados del LLM ──────────────────────────
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

  // ─── Tooltip (delegación de eventos en el área del editor) ────────────────

  /**
   * Usamos delegación de eventos en el contenedor `.desktop` en lugar de
   * listeners por elemento porque el DOM del editor es gestionado por
   * ProseMirror — Angular no puede poner bindings en sus nodos internos.
   *
   * `mouseover` se propaga desde el elemento más profundo hacia arriba.
   * `closest('.ann')` sube el árbol hasta encontrar el span de anotación
   * o devuelve null si el cursor está sobre texto no anotado.
   */
  protected onEditorMouseOver(event: MouseEvent): void {
    const annEl = (event.target as HTMLElement).closest<HTMLElement>('.ann');

    if (!annEl) {
      // El cursor salió de todos los spans de anotación
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
    // Centramos el tooltip horizontalmente sobre el elemento anotado
    this.tooltipPos.set({ x: rect.left + rect.width / 2, y: rect.top });
    this.tooltipVisible.set(true);
  }

  protected onEditorMouseLeave(): void {
    this.tooltipVisible.set(false);
  }

  /**
   * Clic sobre un span de anotación → log detallado en consola.
   * Útil para inspeccionar rápidamente el contexto completo de una
   * anotación sin abrir el panel de debug.
   */
  protected onEditorClick(event: MouseEvent): void {
    const annEl = (event.target as HTMLElement).closest<HTMLElement>('.ann');
    if (!annEl) return;

    const annId = annEl.dataset['annId'];
    const ann = this.currentAnns().find((a) => a.id === annId);
    if (!ann) return;

    const text = this.currentFullText().slice(ann.start, ann.end);
    const visual = ANNOTATION_VISUAL[ann.type as AnnotationType];

    // Calculamos también las posiciones ProseMirror para el desarrollador
    const from = annEl.getAttribute('data-ann-id')
      ? this.editor.state.selection.anchor // valor indicativo
      : -1;

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

  // ─── API pública ──────────────────────────────────────────────────────────

  getLLMContext(): LLMEditContext {
    return buildLLMContext(this.editor);
  }

  // ─── Helpers privados ─────────────────────────────────────────────────────

  /**
   * Detecta párrafos que se modifican por primera vez y loguea su texto
   * original. Funciona comparando el conjunto de índices de párrafos
   * marcados como modificados con los que ya hemos reportado antes.
   */
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

  /** Guarda el texto de cada párrafo indexado por su posición ordinal. */
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
