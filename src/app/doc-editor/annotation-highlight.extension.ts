import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Node as PmNode } from '@tiptap/pm/model';
import { TextAnnotation } from './semantic-annotations.types';

// ─── Estado del plugin ────────────────────────────────────────────────────────

interface AnnotationPluginState {
  annotations: TextAnnotation[];
  decorations: DecorationSet;
}

export const ANNOTATION_KEY = new PluginKey<AnnotationPluginState>('semanticAnnotations');

/**
 * Abreviaturas para el x-ray mode. Se escriben como data-ann-abbr en cada
 * <span> para que el pseudo-elemento ::before pueda leerlas con content: attr(…).
 * Son más cortas que los type names completos, lo que evita solapamientos visuales.
 */
const ABBRS: Record<string, string> = {
  dialogue: 'DLG',
  beat: 'BT',
  narration: 'NAR',
  'character-ref': 'PRS',
  'location-ref': 'LUG',
  'internal-thought': 'PNS',
};

// ─── Conversión de offsets ────────────────────────────────────────────────────

/**
 * Convierte un offset de carácter en fullText (bloques separados por '\n')
 * a una posición ProseMirror.
 *
 * Exportada para que el debug panel pueda calcular posiciones PM sin
 * duplicar la lógica.
 */
export function charOffsetToPmPos(doc: PmNode, charOffset: number): number {
  let remaining = charOffset;
  let result = -1;

  doc.forEach((node, pmOffset) => {
    if (result >= 0) return;
    const len = node.textContent.length;
    if (remaining <= len) {
      result = pmOffset + 1 + remaining;
    } else {
      remaining -= len + 1; // +1 por el '\n' separador en fullText
    }
  });

  return result >= 0 ? result : doc.content.size;
}

// ─── Construcción de decoraciones ────────────────────────────────────────────

function buildDecorations(doc: PmNode, annotations: TextAnnotation[]): DecorationSet {
  const decos: Decoration[] = [];

  for (const ann of annotations) {
    const from = charOffsetToPmPos(doc, ann.start);
    const to = charOffsetToPmPos(doc, ann.end);
    if (from >= to || to > doc.content.size) continue;

    decos.push(
      Decoration.inline(from, to, {
        class: `ann ann--${ann.type}`,
        'data-ann-id': ann.id,
        'data-ann-type': ann.type,
        // Abreviatura para x-ray mode (leída por ::before via CSS attr())
        'data-ann-abbr': ABBRS[ann.type] ?? ann.type.slice(0, 3).toUpperCase(),
        ...(ann.metadata ? { 'data-ann-meta': JSON.stringify(ann.metadata) } : {}),
      }),
    );
  }

  return DecorationSet.create(doc, decos);
}

// ─── La extensión ─────────────────────────────────────────────────────────────

export const AnnotationHighlightExtension = Extension.create({
  name: 'annotationHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<AnnotationPluginState>({
        key: ANNOTATION_KEY,

        state: {
          init: (): AnnotationPluginState => ({
            annotations: [],
            decorations: DecorationSet.empty,
          }),

          apply(tr, prev, _old, newState): AnnotationPluginState {
            const meta = tr.getMeta(ANNOTATION_KEY);

            if (meta?.annotations !== undefined) {
              return {
                annotations: meta.annotations,
                decorations: buildDecorations(newState.doc, meta.annotations),
              };
            }

            if (meta?.clear) {
              return { annotations: [], decorations: DecorationSet.empty };
            }

            if (tr.docChanged) {
              return {
                ...prev,
                decorations: prev.decorations.map(tr.mapping, tr.doc),
              };
            }

            return prev;
          },
        },

        props: {
          decorations: (state) =>
            ANNOTATION_KEY.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});

// ─── API pública ──────────────────────────────────────────────────────────────

export function setAnnotations(
  editor: { state: any; view: any },
  annotations: TextAnnotation[],
): void {
  editor.view.dispatch(editor.state.tr.setMeta(ANNOTATION_KEY, { annotations }));
}

export function clearAnnotations(editor: { state: any; view: any }): void {
  editor.view.dispatch(editor.state.tr.setMeta(ANNOTATION_KEY, { clear: true }));
}

export function getAnnotationCount(editor: { state: any }): number {
  return ANNOTATION_KEY.getState(editor.state)?.annotations.length ?? 0;
}

/**
 * Devuelve la lista completa de anotaciones activas.
 * El debug panel y el componente la usan para mostrar detalles sin
 * tener que pasar el estado como prop en cada render.
 */
export function getAnnotations(editor: { state: any }): TextAnnotation[] {
  return ANNOTATION_KEY.getState(editor.state)?.annotations ?? [];
}
