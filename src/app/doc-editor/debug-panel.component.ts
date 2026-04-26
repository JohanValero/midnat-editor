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
import { ChunkLog, ChunkStatus, LiveAnnotation } from './chunk-log.types';

type Tab = 'annotations' | 'operations' | 'structure' | 'cursor' | 'live';

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
  textBefore: string;
  textAfter: string;
}

@Component({
  selector: 'app-debug-panel',
  standalone: true,
  templateUrl: 'debug-panel.component.html',
  styleUrls: ['debug-panel.component.scss'],
})
export class DebugPanelComponent implements OnChanges {
  @Input() annotations: TextAnnotation[] = [];
  @Input() fullText = '';
  @Input() editor: Editor | null = null;
  @Input() tick = 0;
  @Output() closed = new EventEmitter<void>();

  @Input() chunkLogs: ChunkLog[] = [];

  protected readonly VISUAL = ANNOTATION_VISUAL;
  protected readonly TABS: { id: Tab; label: string }[] = [
    { id: 'annotations', label: `Anots (${this.annotations.length})` },
    { id: 'operations', label: 'Ops' },
    { id: 'structure', label: 'Doc' },
    { id: 'cursor', label: 'Cursor' },
    { id: 'live', label: '⚡ Live' },
  ];

  protected activeTab = signal<Tab>('annotations');
  protected ops = signal<EditOperation[]>([]);
  protected nodes = signal<DocNodeInfo[]>([]);
  protected cursor = signal<CursorInfo | null>(null);

  // Chunks expandidos a nivel de tarjeta
  protected expandedChunks = signal(new Set<number>());

  // Sub-secciones expandidas: clave = "{chunkIndex}:{section}"
  // Secciones: "input" | "refs-think" | "refs-xml" | "blocks-think" | "blocks-xml"
  // Todas están ocultas por defecto; el usuario las abre manualmente.
  protected expandedSubs = signal(new Map<string, boolean>());

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['tick'] || changes['editor']) this.refresh();
    this.TABS[0].label = `Anots (${this.annotations.length})`;

    if (changes['chunkLogs']) {
      const prev: ChunkLog[] = changes['chunkLogs'].previousValue ?? [];
      const curr: ChunkLog[] = this.chunkLogs;

      // Primera carga → activar pestaña Live
      if (curr.length === 1 && prev.length === 0) {
        this.activeTab.set('live');
        this.expandedChunks.set(new Set([0]));
      }
      // Nuevo chunk → expandir su tarjeta automáticamente
      if (curr.length > prev.length) {
        const newest = curr[curr.length - 1];
        this.expandedChunks.update((s) => new Set([...s, newest.index]));
      }
    }
  }

  private refresh(): void {
    if (!this.editor) return;
    const { state } = this.editor;
    const tracker = getTrackerState(this.editor);

    this.ops.set([...(tracker?.operations ?? [])].reverse());
    const modifiedOffsets = tracker?.modifiedOffsets ?? new Set<number>();

    const nodes: DocNodeInfo[] = [];
    let charBase = 0;
    state.doc.forEach((node, pmOffset) => {
      const charEnd = charBase + node.textContent.length;
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
      charBase += node.textContent.length + 1;
    });
    this.nodes.set(nodes);

    const sel = state.selection;
    const textToAnchor = state.doc.textBetween(0, sel.anchor, '\n');
    let paraIdx = -1,
      pIdx = 0;
    state.doc.forEach((node, o) => {
      if (sel.anchor > o && sel.anchor <= o + node.nodeSize) paraIdx = pIdx;
      pIdx++;
    });
    this.cursor.set({
      anchorPm: sel.anchor,
      headPm: sel.head,
      isRange: !sel.empty,
      paraIndex: paraIdx,
      charOffset: textToAnchor.length,
      textBefore: textToAnchor.slice(-40),
      textAfter: state.doc.textBetween(
        sel.anchor,
        Math.min(sel.anchor + 40, state.doc.content.size),
        '\n',
      ),
    });
  }

  // ── Chunk-level expand/collapse ──────────────────────────────────────────────

  protected isExpanded(index: number): boolean {
    // Sin forzado: los chunks activos pueden colapsarse como cualquier otro
    return this.expandedChunks().has(index);
  }

  protected toggleExpand(index: number): void {
    this.expandedChunks.update((s) => {
      const next = new Set(s);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  // ── Sub-section expand/collapse (thinking, XML, input text) ─────────────────

  protected isSubExpanded(chunkIndex: number, section: string): boolean {
    return this.expandedSubs().get(`${chunkIndex}:${section}`) ?? false;
  }

  protected toggleSub(chunkIndex: number, section: string): void {
    const key = `${chunkIndex}:${section}`;
    this.expandedSubs.update((m) => {
      const next = new Map(m);
      next.set(key, !(next.get(key) ?? false));
      return next;
    });
  }

  // ── Helpers de presentación ──────────────────────────────────────────────────

  /**
   * Extrae el contenido del primer <title> del XML de bloques.
   * Se llama desde la plantilla para mostrarlo como badge en la cabecera del chunk.
   * Funciona aunque el XML sea parcial (streaming), siempre que </title> ya haya llegado.
   */
  protected extractTitle(blocksXml: string): string | null {
    const m = blocksXml.match(/<title>([\s\S]*?)<\/title>/);
    return m ? m[1].trim() : null;
  }

  /** Etiqueta de estado enriquecida con la pasada en curso. */
  protected statusLabel(log: ChunkLog): string {
    if (log.status === 'thinking') return log.currentPass === 'refs' ? '🔍' : '🧠';
    if (log.status === 'generating') return log.currentPass === 'refs' ? '⚙¹' : '⚙²';
    if (log.status === 'done') return '✓';
    return '✗';
  }

  protected isActive(log: ChunkLog): boolean {
    return log.status === 'thinking' || log.status === 'generating';
  }

  protected getAnnPreview(ann: TextAnnotation): string {
    const text = this.fullText.slice(ann.start, ann.end);
    return text.length > 48 ? text.slice(0, 48) + '…' : text;
  }

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
    if (ann.metadata && Object.keys(ann.metadata).length) console.log('metadata:', ann.metadata);
    console.groupEnd();
  }

  protected relativeTime(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 3) return 'ahora';
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m`;
  }

  protected get reversedLogs(): ChunkLog[] {
    return [...this.chunkLogs].reverse();
  }

  protected annVisual(type: AnnotationType) {
    return ANNOTATION_VISUAL[type];
  }

  protected get overallProgress(): number {
    if (!this.chunkLogs.length) return 0;
    const done = this.chunkLogs.filter((l) => l.status === 'done' || l.status === 'error').length;
    return Math.round((done / this.chunkLogs[0].total) * 100);
  }
}
