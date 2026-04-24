import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { ReplaceStep } from '@tiptap/pm/transform';

// ─── Tipos públicos ───────────────────────────────────────────────────────────

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

/**
 * Exportado para que el debug panel y el componente puedan leer el estado
 * completo del plugin sin duplicar la lógica.
 */
export interface TrackerState {
  modifiedOffsets: Set<number>;
  operations: EditOperation[];
}

// ─── Estado interno del plugin ────────────────────────────────────────────────

export const TRACKER_KEY = new PluginKey<TrackerState>('changeTracker');

const CONTEXT_WINDOW = 300;
const MAX_OPS = 200;

// ─── La extensión ─────────────────────────────────────────────────────────────

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
            const newOps: EditOperation[] = [];
            const newModified = new Set(prev.modifiedOffsets);

            tr.steps.forEach((step) => {
              if (!(step instanceof ReplaceStep)) return;
              const { from, to } = step;

              if (to > from) {
                const deleted = oldState.doc.textBetween(from, to, '\n');
                if (deleted) {
                  newOps.push({ type: 'delete', position: from, text: deleted, timestamp: now });
                }
              }

              if (step.slice.content.size > 0) {
                const inserted = step.slice.content.textBetween(0, step.slice.content.size, '\n');
                if (inserted) {
                  newOps.push({ type: 'insert', position: from, text: inserted, timestamp: now });
                }
              }

              newState.doc.forEach((node, offset) => {
                if (step.from < offset + node.nodeSize && step.to > offset) {
                  newModified.add(offset);
                }
              });
            });

            return {
              modifiedOffsets: newModified,
              operations: [...prev.operations, ...newOps].slice(-MAX_OPS),
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

// ─── API pública ──────────────────────────────────────────────────────────────

export function getModifiedCount(editor: { state: any }): number {
  return TRACKER_KEY.getState(editor.state)?.modifiedOffsets.size ?? 0;
}

/**
 * Devuelve el estado completo del plugin de tracking.
 * Útil para el debug panel y para detectar primeras modificaciones.
 */
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
