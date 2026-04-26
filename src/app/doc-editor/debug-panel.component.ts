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
import { AnalysisType, ChunkLog, ChunkStatus, LiveAnnotation } from './chunk-log.types';

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

// Metadatos visuales por tipo de análisis, para badges e indicadores de estado
const ANALYSIS_META: Record<AnalysisType, { icon: string; label: string; color: string }> = {
  refs: { icon: '🔍', label: 'Referencias', color: '#34d399' },
  blocks: { icon: '📄', label: 'Estructura', color: '#60a5fa' },
  conversations: { icon: '💬', label: 'Conversaciones', color: '#f87171' },
};

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
  protected readonly ANALYSIS_META = ANALYSIS_META;
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

  protected expandedChunks = signal(new Set<string>()); // clave = `${analysisType}:${index}`
  protected expandedSubs = signal(new Map<string, boolean>());

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['tick'] || changes['editor']) this.refresh();
    this.TABS[0].label = `Anots (${this.annotations.length})`;

    if (changes['chunkLogs']) {
      const prev: ChunkLog[] = changes['chunkLogs'].previousValue ?? [];
      const curr: ChunkLog[] = this.chunkLogs;

      if (curr.length === 1 && prev.length === 0) {
        this.activeTab.set('live');
        this.expandedChunks.set(new Set([this._chunkKey(curr[0])]));
      }
      if (curr.length > prev.length) {
        const newest = curr[curr.length - 1];
        this.expandedChunks.update((s) => new Set([...s, this._chunkKey(newest)]));
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

  // ── Expand/collapse de tarjetas de chunk ────────────────────────────────────

  /** Clave única para un ChunkLog: combina analysisType + index. */
  protected _chunkKey(log: ChunkLog): string {
    return `${log.analysisType}:${log.index}`;
  }

  protected isExpanded(log: ChunkLog): boolean {
    return this.expandedChunks().has(this._chunkKey(log));
  }

  protected toggleExpand(log: ChunkLog): void {
    this.expandedChunks.update((s) => {
      const key = this._chunkKey(log);
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // ── Expand/collapse de sub-secciones ────────────────────────────────────────

  protected isSubExpanded(log: ChunkLog, section: string): boolean {
    return this.expandedSubs().get(`${this._chunkKey(log)}:${section}`) ?? false;
  }

  protected toggleSub(log: ChunkLog, section: string): void {
    const key = `${this._chunkKey(log)}:${section}`;
    this.expandedSubs.update((m) => {
      const next = new Map(m);
      next.set(key, !(next.get(key) ?? false));
      return next;
    });
  }

  // ── Helpers de presentación ──────────────────────────────────────────────────

  /** Icono + estado para la cabecera de la tarjeta de chunk. */
  protected statusLabel(log: ChunkLog): string {
    const meta = ANALYSIS_META[log.analysisType];
    if (log.status === 'thinking') return meta.icon; // animado en CSS
    if (log.status === 'generating') return '⚙';
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

  /** Progreso global: fracción de chunks en estado 'done' o 'error'. */
  protected get overallProgress(): number {
    if (!this.chunkLogs.length) return 0;
    const done = this.chunkLogs.filter((l) => l.status === 'done' || l.status === 'error').length;
    // El total real son los chunks del primer análisis que llegó; usamos
    // el campo `total` del primer log como referencia.
    const total = this.chunkLogs[0]?.total ?? 1;
    return Math.round((done / total) * 100);
  }

  /** Extrae el texto del primer <title> del XML, si ya se generó. */
  protected extractTitle(xmlContent: string): string | null {
    const m = xmlContent.match(/<title>([\s\S]*?)<\/title>/);
    return m ? m[1].trim() : null;
  }
}
