import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReplaceStep } from '@tiptap/pm/transform';

export interface EditOperation {
  type: 'insert' | 'delete';
  position: number;
  text: string;
  timestamp: number;
}

export interface LLMEditContext {
  fullText: string;
  cursorCharOffset: number;
  textBefore: string;
  textAfter: string;
  recentOperations: EditOperation[];
  modifiedParagraphCount: number;
}

export interface TrackerState {
  modifiedOffsets: Set<number>;
  operations: EditOperation[];
}

export const TRACKER_KEY = new PluginKey<TrackerState>('changeTracker');

const CONTEXT_WINDOW = 300;
const MAX_OPS = 200;

export const ChangeTrackerExtension = Extension.create({
  name: 'changeTracker',

  addProseMirrorPlugins() {
    return [
      new Plugin<TrackerState>({
        key: TRACKER_KEY,

        state: {
          init(): TrackerState {
            return { modifiedOffsets: new Set(), operations: [] };
          },

          apply(tr, prev, oldState, newState): TrackerState {
            if (tr.getMeta(TRACKER_KEY)?.reset) {
              return { modifiedOffsets: new Set(), operations: [] };
            }
            if (!tr.docChanged) return prev;

            const now = Date.now();
            let newOps = [...prev.operations];

            tr.steps.forEach((step, index) => {
              if (!(step instanceof ReplaceStep)) {
                const stepMap = step.getMap();
                newOps = newOps.map((op) => ({
                  ...op,
                  position: stepMap.map(op.position),
                }));
                return;
              }

              const stepDoc = tr.docs[index];
              const { from, to } = step;

              const deleted = to > from ? stepDoc.textBetween(from, to, '\n') : '';
              const inserted =
                step.slice.content.size > 0
                  ? step.slice.content.textBetween(0, step.slice.content.size, '\n')
                  : '';

              const actions: Array<{ type: 'insert' | 'delete'; text: string }> = [];
              if (deleted) actions.push({ type: 'delete', text: deleted });
              if (inserted) actions.push({ type: 'insert', text: inserted });

              for (const action of actions) {
                const lastOp = newOps[newOps.length - 1];
                let canceled = false;

                if (lastOp && lastOp.position === from) {
                  if (
                    action.type === 'delete' &&
                    lastOp.type === 'insert' &&
                    lastOp.text === action.text
                  ) {
                    newOps.pop();
                    canceled = true;
                  } else if (
                    action.type === 'insert' &&
                    lastOp.type === 'delete' &&
                    lastOp.text === action.text
                  ) {
                    newOps.pop();
                    canceled = true;
                  }
                }

                if (!canceled) {
                  newOps.push({
                    type: action.type,
                    position: from,
                    text: action.text,
                    timestamp: now,
                  });
                }
              }

              const stepMap = step.getMap();
              newOps = newOps.map((op) => ({
                ...op,
                position: stepMap.map(op.position),
              }));
            });

            if (newOps.length > MAX_OPS) {
              newOps = newOps.slice(-MAX_OPS);
            }

            const newModified = new Set<number>();
            newState.doc.forEach((node, offset) => {
              const blockEnd = offset + node.nodeSize;
              const hasOp = newOps.some((op) => op.position >= offset && op.position < blockEnd);
              if (hasOp) {
                newModified.add(offset);
              }
            });

            return {
              modifiedOffsets: newModified,
              operations: newOps,
            };
          },
        },

        props: {
          decorations(state) {
            const pluginState = TRACKER_KEY.getState(state);
            if (!pluginState?.modifiedOffsets.size) return DecorationSet.empty;

            const decos: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              if (pluginState.modifiedOffsets.has(offset)) {
                decos.push(
                  Decoration.node(offset, offset + node.nodeSize, {
                    class: 'paragraph--modified',
                  }),
                );
              }
            });
            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

export function getModifiedCount(editor: { state: any }): number {
  return TRACKER_KEY.getState(editor.state)?.modifiedOffsets.size ?? 0;
}

export function getTrackerState(editor: { state: any }): TrackerState | undefined {
  return TRACKER_KEY.getState(editor.state);
}

export function buildLLMContext(editor: { state: any }): LLMEditContext {
  const { state } = editor;
  const pluginState = TRACKER_KEY.getState(state) ?? {
    modifiedOffsets: new Set<number>(),
    operations: [] as EditOperation[],
  };

  const fullText = docToText(state.doc);
  const cursorCharOffset = state.doc.textBetween(0, state.selection.anchor, '\n').length;

  return {
    fullText,
    cursorCharOffset,
    textBefore: fullText.slice(Math.max(0, cursorCharOffset - CONTEXT_WINDOW), cursorCharOffset),
    textAfter: fullText.slice(cursorCharOffset, cursorCharOffset + CONTEXT_WINDOW),
    recentOperations: pluginState.operations.slice(-20),
    modifiedParagraphCount: pluginState.modifiedOffsets.size,
  };
}

function docToText(doc: any): string {
  const parts: string[] = [];
  doc.forEach((node: any) => parts.push(node.textContent));
  return parts.join('\n');
}
