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

  protected readonly VISUAL = ANNOTATION_VISUAL;
  protected readonly TABS: { id: Tab; label: string }[] = [
    { id: 'annotations', label: `Anots (${this.annotations.length})` },
    { id: 'operations', label: 'Ops' },
    { id: 'structure', label: 'Doc' },
    { id: 'cursor', label: 'Cursor' },
  ];

  protected activeTab = signal<Tab>('annotations');
  protected ops = signal<EditOperation[]>([]);
  protected nodes = signal<DocNodeInfo[]>([]);
  protected cursor = signal<CursorInfo | null>(null);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['tick'] || changes['editor']) {
      this.refresh();
    }
    this.TABS[0].label = `Anots (${this.annotations.length})`;
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
    const charOff = textToAnchor.length;

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
    if (ann.metadata && Object.keys(ann.metadata).length) {
      console.log('metadata:', ann.metadata);
    }
    console.groupEnd();
  }

  protected relativeTime(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 3) return 'ahora';
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m`;
  }
}
