import {
  Component,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  signal,
  SimpleChanges,
} from '@angular/core';
import { Editor } from '@tiptap/core';
import { EditOperation, getTrackerState } from './change-tracker.extension';
import { TextAnnotation, ANNOTATION_VISUAL, AnnotationType } from './semantic-annotations.types';
import { buildLLMContext } from './change-tracker.extension';

// ─── Tipos internos del panel ─────────────────────────────────────────────────

type Tab = 'annotations' | 'operations' | 'structure' | 'cursor';

interface DocNodeInfo {
  index: number;
  type: string;
  pmOffset: number;
  charCount: number;
  preview: string;
  isModified: boolean;
  annCount: number;
}

interface CursorInfo {
  anchorPm: number;
  headPm: number;
  isRange: boolean;
  paraIndex: number;
  charOffset: number;
  textBefore: string; // últimos ~40 chars antes del cursor
  textAfter: string; // primeros ~40 chars después del cursor
}

// ─── Componente ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-debug-panel',
  standalone: true,
  // Estilos scoped al componente via ViewEncapsulation.Emulated (por defecto),
  // lo que significa que los selectores no "escapan" al árbol del editor.
  template: `
    <div class="dp">
      <!-- ── Cabecera con pestañas ──────────────────────────────── -->
      <div class="dp__header">
        <span class="dp__title">⚙ Debug</span>
        <div class="dp__tabs">
          @for (t of TABS; track t.id) {
            <button
              class="dp__tab"
              [class.dp__tab--active]="activeTab() === t.id"
              (click)="activeTab.set(t.id)"
            >
              {{ t.label }}
            </button>
          }
        </div>
        <button class="dp__close" (click)="closed.emit()" title="Cerrar panel">✕</button>
      </div>

      <!-- ── Cuerpo ─────────────────────────────────────────────── -->
      <div class="dp__body">
        <!-- PESTAÑA: Anotaciones -->
        @if (activeTab() === 'annotations') {
          @if (annotations.length === 0) {
            <p class="dp__empty">Sin anotaciones. Pulsa <em>Analizar</em>.</p>
          }
          @for (ann of annotations; track ann.id) {
            <div
              class="dp__row"
              (click)="logAnnotation(ann)"
              title="Clic para ver detalles en consola"
            >
              <span class="dp__badge" [class]="'dp__badge--' + ann.type">
                {{ VISUAL[ann.type]?.label ?? ann.type }}
              </span>
              <code class="dp__code">{{ ann.start }}–{{ ann.end }}</code>
              @if (ann.metadata?.['name']) {
                <span class="dp__meta">{{ ann.metadata!['name'] }}</span>
              }
              <span class="dp__preview">{{ getAnnPreview(ann) }}</span>
            </div>
          }
        }

        <!-- PESTAÑA: Operaciones -->
        @if (activeTab() === 'operations') {
          @if (ops().length === 0) {
            <p class="dp__empty">Sin operaciones registradas todavía.</p>
          }
          @for (op of ops(); track $index) {
            <div
              class="dp__row"
              [class.dp__row--insert]="op.type === 'insert'"
              [class.dp__row--delete]="op.type === 'delete'"
            >
              <span class="dp__op-sign">{{ op.type === 'insert' ? '+' : '−' }}</span>
              <code class="dp__code">pos:{{ op.position }}</code>
              <span class="dp__preview">
                "{{ op.text.length > 40 ? op.text.slice(0, 40) + '…' : op.text }}"
              </span>
              <span class="dp__ts">{{ relativeTime(op.timestamp) }}</span>
            </div>
          }
        }

        <!-- PESTAÑA: Estructura del documento -->
        @if (activeTab() === 'structure') {
          @if (nodes().length === 0) {
            <p class="dp__empty">Documento vacío.</p>
          }
          @for (n of nodes(); track n.index) {
            <div class="dp__row" [class.dp__row--modified]="n.isModified">
              <code class="dp__code">#{{ n.index }}</code>
              <span class="dp__node-type">{{ n.type }}</span>
              <code class="dp__code">off:{{ n.pmOffset }}</code>
              <code class="dp__code">{{ n.charCount }}c</code>
              @if (n.isModified) {
                <span class="dp__flag dp__flag--mod">mod</span>
              }
              @if (n.annCount > 0) {
                <span class="dp__flag dp__flag--ann">{{ n.annCount }} ann</span>
              }
              <span class="dp__preview">{{ n.preview }}</span>
            </div>
          }
        }

        <!-- PESTAÑA: Cursor -->
        @if (activeTab() === 'cursor') {
          @if (cursor(); as c) {
            <div class="dp__kv">
              <div class="dp__kv-row">
                <span>Anchor PM</span><code>{{ c.anchorPm }}</code>
              </div>
              <div class="dp__kv-row">
                <span>Head PM</span><code>{{ c.headPm }}</code>
              </div>
              <div class="dp__kv-row">
                <span>Modo</span>
                <code>{{ c.isRange ? 'selección' : 'cursor' }}</code>
              </div>
              <div class="dp__kv-row">
                <span>Párrafo #</span><code>{{ c.paraIndex >= 0 ? c.paraIndex : '?' }}</code>
              </div>
              <div class="dp__kv-row">
                <span>Char offset</span><code>{{ c.charOffset }}</code>
              </div>
              <div class="dp__kv-row dp__kv-row--block">
                <span>Antes del cursor</span>
                <code class="dp__ctx">…{{ c.textBefore }}</code>
              </div>
              <div class="dp__kv-row dp__kv-row--block">
                <span>Después del cursor</span>
                <code class="dp__ctx">{{ c.textAfter }}…</code>
              </div>
            </div>
          } @else {
            <p class="dp__empty">Editor no disponible.</p>
          }
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      /* Panel contenedor — posición fija en el lado derecho */
      .dp {
        position: fixed;
        right: 0;
        top: 44px;
        width: 360px;
        height: calc(100vh - 44px);
        background: #0d0d1a;
        color: #e2e8f0;
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
        font-size: 11px;
        display: flex;
        flex-direction: column;
        border-left: 1px solid #1e1e3a;
        z-index: 200;
        overflow: hidden;
        box-shadow: -4px 0 20px rgba(0, 0, 0, 0.4);
      }

      /* Cabecera */
      .dp__header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 8px 10px;
        background: #13132a;
        border-bottom: 1px solid #1e1e3a;
        flex-shrink: 0;
      }
      .dp__title {
        font-size: 11px;
        font-weight: 700;
        color: #a78bfa;
        white-space: nowrap;
        margin-right: 4px;
      }
      .dp__tabs {
        display: flex;
        gap: 2px;
        flex: 1;
      }
      .dp__tab {
        padding: 3px 8px;
        border-radius: 3px;
        border: none;
        background: transparent;
        color: #64748b;
        font-family: inherit;
        font-size: 10px;
        cursor: pointer;
        transition:
          background 0.1s,
          color 0.1s;
        &:hover {
          background: #1e1e3a;
          color: #e2e8f0;
        }
        &--active {
          background: #1e1e3a;
          color: #a78bfa;
          font-weight: 700;
        }
      }
      .dp__close {
        border: none;
        background: transparent;
        color: #475569;
        cursor: pointer;
        font-size: 15px;
        padding: 2px 4px;
        line-height: 1;
        &:hover {
          color: #e2e8f0;
        }
      }

      /* Cuerpo scrollable */
      .dp__body {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
        scrollbar-width: thin;
        scrollbar-color: #1e1e3a #0d0d1a;
      }

      /* Estado vacío */
      .dp__empty {
        color: #334155;
        text-align: center;
        padding: 28px 16px;
        margin: 0;
        em {
          color: #475569;
          font-style: normal;
          font-weight: 600;
        }
      }

      /* Fila genérica */
      .dp__row {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 5px;
        padding: 4px 10px;
        border-bottom: 1px solid #0d0d1a;
        cursor: pointer;
        border-left: 2px solid transparent;
        transition: background 0.1s;
        &:hover {
          background: #13132a;
        }
        /* Modificadores de estado */
        &--insert {
          border-left-color: #34d399;
        }
        &--delete {
          border-left-color: #f87171;
        }
        &--modified {
          border-left-color: #f59e0b;
        }
      }

      /* Badge de tipo de anotación */
      .dp__badge {
        font-size: 9px;
        font-weight: 700;
        padding: 1px 5px;
        border-radius: 3px;
        text-transform: uppercase;
        white-space: nowrap;
        flex-shrink: 0;

        &--dialogue {
          background: rgba(248, 113, 113, 0.2);
          color: #fca5a5;
        }
        &--beat {
          background: rgba(244, 114, 182, 0.2);
          color: #f9a8d4;
        }
        &--narration {
          background: rgba(96, 165, 250, 0.2);
          color: #93c5fd;
        }
        &--character-ref {
          background: rgba(52, 211, 153, 0.2);
          color: #6ee7b7;
        }
        &--location-ref {
          background: rgba(251, 191, 36, 0.2);
          color: #fde68a;
        }
        &--internal-thought {
          background: rgba(167, 139, 250, 0.2);
          color: #c4b5fd;
        }
      }

      .dp__code {
        font-family: inherit;
        font-size: 10px;
        color: #475569;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .dp__meta {
        color: #6ee7b7;
        font-style: italic;
        flex-shrink: 0;
        max-width: 100px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dp__preview {
        color: #64748b;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Operaciones */
      .dp__op-sign {
        font-size: 14px;
        font-weight: 700;
        flex-shrink: 0;
        width: 12px;
        text-align: center;
        .dp__row--insert & {
          color: #34d399;
        }
        .dp__row--delete & {
          color: #f87171;
        }
      }
      .dp__ts {
        color: #334155;
        flex-shrink: 0;
        margin-left: auto;
      }

      /* Estructura */
      .dp__node-type {
        color: #818cf8;
        font-weight: 700;
        flex-shrink: 0;
      }
      .dp__flag {
        font-size: 9px;
        padding: 1px 4px;
        border-radius: 2px;
        font-weight: 700;
        flex-shrink: 0;
        &--mod {
          background: rgba(245, 158, 11, 0.15);
          color: #fcd34d;
        }
        &--ann {
          background: rgba(167, 139, 250, 0.15);
          color: #c4b5fd;
        }
      }

      /* Cursor info: lista clave-valor */
      .dp__kv {
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .dp__kv-row {
        display: flex;
        align-items: baseline;
        gap: 8px;
        span {
          color: #475569;
          width: 110px;
          flex-shrink: 0;
          font-size: 10px;
        }
        code {
          color: #a78bfa;
          font-family: inherit;
        }
        &--block {
          flex-direction: column;
          gap: 3px;
          span {
            width: auto;
          }
        }
      }
      .dp__ctx {
        font-family: inherit;
        color: #64748b;
        font-size: 10px;
        display: block;
        white-space: pre-wrap;
        word-break: break-all;
        margin-left: 6px;
        line-height: 1.6;
      }
    `,
  ],
})
export class DebugPanelComponent implements OnChanges {
  // ── Entradas ──────────────────────────────────────────────────────────────
  @Input() annotations: TextAnnotation[] = [];
  @Input() fullText = '';
  @Input() editor: Editor | null = null;
  /**
   * Incrementa en cada transacción del editor (signal en el componente padre).
   * Angular detecta el cambio y dispara ngOnChanges, que refresca los datos.
   * Es el mecanismo más simple para sincronizar el panel con el estado interno
   * de ProseMirror sin suscripciones manuales ni setInterval.
   */
  @Input() tick = 0;

  @Output() closed = new EventEmitter<void>();

  // ── Constantes de UI ──────────────────────────────────────────────────────
  protected readonly VISUAL = ANNOTATION_VISUAL;
  protected readonly TABS: { id: Tab; label: string }[] = [
    { id: 'annotations', label: `Anots (${this.annotations.length})` },
    { id: 'operations', label: 'Ops' },
    { id: 'structure', label: 'Doc' },
    { id: 'cursor', label: 'Cursor' },
  ];

  // ── Estado reactivo ───────────────────────────────────────────────────────
  protected activeTab = signal<Tab>('annotations');
  protected ops = signal<EditOperation[]>([]);
  protected nodes = signal<DocNodeInfo[]>([]);
  protected cursor = signal<CursorInfo | null>(null);

  // ─── Ciclo de vida ────────────────────────────────────────────────────────

  ngOnChanges(changes: SimpleChanges): void {
    // Refrescamos la vista cada vez que el editor emite una transacción
    // (señalizado por el incremento de `tick`) o cuando cambia el editor mismo.
    if (changes['tick'] || changes['editor']) {
      this.refresh();
    }
    // Actualizamos el label de la pestaña de anotaciones con el count actual
    this.TABS[0].label = `Anots (${this.annotations.length})`;
  }

  private refresh(): void {
    if (!this.editor) return;
    const { state } = this.editor;

    // ── Operaciones del tracker (más recientes primero) ───────────────────
    const tracker = getTrackerState(this.editor);
    this.ops.set([...(tracker?.operations ?? [])].reverse());

    // ── Estructura del documento ──────────────────────────────────────────
    const modifiedOffsets = tracker?.modifiedOffsets ?? new Set<number>();
    const nodes: DocNodeInfo[] = [];
    let charBase = 0; // para correlacionar párrafos con anotaciones por char offset

    state.doc.forEach((node, pmOffset) => {
      const charEnd = charBase + node.textContent.length;

      // Contamos cuántas anotaciones empiezan dentro de este bloque
      const annCount = this.annotations.filter(
        (a) => a.start >= charBase && a.start < charEnd,
      ).length;

      nodes.push({
        index: nodes.length,
        type: node.type.name,
        pmOffset,
        charCount: node.textContent.length,
        preview: node.textContent.slice(0, 48),
        isModified: modifiedOffsets.has(pmOffset),
        annCount,
      });

      charBase += node.textContent.length + 1; // +1 por el '\n' del fullText
    });
    this.nodes.set(nodes);

    // ── Cursor / selección ────────────────────────────────────────────────
    const sel = state.selection;
    const textToAnchor = state.doc.textBetween(0, sel.anchor, '\n');
    const charOff = textToAnchor.length;

    // Encontrar en qué párrafo está el cursor por comparación de offsets
    let paraIdx = -1;
    let pIdx = 0;
    state.doc.forEach((node, o) => {
      if (sel.anchor > o && sel.anchor <= o + node.nodeSize) paraIdx = pIdx;
      pIdx++;
    });

    this.cursor.set({
      anchorPm: sel.anchor,
      headPm: sel.head,
      isRange: !sel.empty,
      paraIndex: paraIdx,
      charOffset: charOff,
      textBefore: textToAnchor.slice(-40),
      textAfter: state.doc.textBetween(
        sel.anchor,
        Math.min(sel.anchor + 40, state.doc.content.size),
        '\n',
      ),
    });
  }

  // ─── Helpers de template ──────────────────────────────────────────────────

  /** Devuelve un extracto del texto cubierto por la anotación. */
  protected getAnnPreview(ann: TextAnnotation): string {
    const text = this.fullText.slice(ann.start, ann.end);
    return text.length > 48 ? text.slice(0, 48) + '…' : text;
  }

  /** Loguea todos los detalles de una anotación al hacer clic sobre ella en el panel. */
  protected logAnnotation(ann: TextAnnotation): void {
    const text = this.fullText.slice(ann.start, ann.end);
    const visual = ANNOTATION_VISUAL[ann.type as AnnotationType];
    console.group(
      `%c[Panel → Anotación] ${visual?.label ?? ann.type}  (${ann.id})`,
      `color: ${visual?.border ?? '#a78bfa'}; font-weight: bold`,
    );
    console.log('tipo:    ', ann.type);
    console.log('rango:   ', `char ${ann.start} → ${ann.end}  (${ann.end - ann.start} chars)`);
    console.log('texto:   ', `"${text}"`);
    if (ann.metadata && Object.keys(ann.metadata).length) {
      console.log('metadata:', ann.metadata);
    }
    console.groupEnd();
  }

  /** Formatea una marca de tiempo Unix como tiempo relativo legible. */
  protected relativeTime(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 3) return 'ahora';
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m`;
  }
}
