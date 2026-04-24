import { Injectable } from '@angular/core';
import { AnnotationType, TextAnnotation } from './semantic-annotations.types';

// ─── Utilidades ───────────────────────────────────────────────────────────────

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Verbos de atribución comunes en español literario.
 * Si un segmento contiene uno de estos verbos se clasifica como "beat"
 * (atribución del narrador + posible acción física del personaje).
 */
const ATTR_VERBS_RE =
  /\b(dij[oa]s?|dec[íi]a[n]?|respond[íi][oa]s?|pregunt[óo]|exclam[óo]|murmuró|gritó|contestó|añadió|continuó|repuso|susurró|intervino|comentó|confesó|admitió|insistió|gruñó|siseó|bufó|masculló)\b/i;

/**
 * Detector de nombres propios compuestos en español.
 * Captura patrones del tipo:
 *   "Bjorn el Errante"   → NOMBRE + conector + NOMBRE
 *   "Hija de la Noche"   → NOMBRE + prep. + art. + NOMBRE
 *   "Ser Davos Marino"   → TÍTULO + NOMBRE + APELLIDO
 */
const NAME_RE =
  /\b([A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+(?:\s+(?:el|la|los|las|de|del|von|van|al|ser|lord|lady|maestre)\s+)?[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+(?:\s+[A-ZÁÉÍÓÚÜÑ][a-záéíóúüñ]+)*)\b/g;

// ─── Servicio ─────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class LlmAnnotationService {
  /**
   * Analiza el texto completo del documento y devuelve anotaciones.
   *
   * `fullText` debe ser exactamente el string devuelto por buildLLMContext(),
   * es decir, los textContent de cada bloque ProseMirror unidos por '\n'.
   * Eso garantiza que los offsets de caracteres sean coherentes con los que
   * usará charOffsetToPmPos() en la extensión.
   *
   * TODO: reemplazar el cuerpo de este método por una llamada real al LLM
   * cuando esté disponible el endpoint. La firma pública no cambia.
   */
  async analyze(fullText: string): Promise<TextAnnotation[]> {
    // Simulamos la latencia de red de un LLM (600-1000 ms)
    await delay(600 + Math.random() * 400);
    return this.heuristicAnnotate(fullText);
  }

  // ─── Implementación heurística (mock) ──────────────────────────────────────

  private heuristicAnnotate(fullText: string): TextAnnotation[] {
    const all: TextAnnotation[] = [];
    let idCounter = 0;
    let charBase = 0;

    for (const para of fullText.split('\n')) {
      if (para.trim()) {
        const paraAnns = this.annotateParagraph(para, charBase, { n: idCounter });
        idCounter += paraAnns.length;
        all.push(...paraAnns);
      }
      // +1 porque el separador '\n' ocupa un carácter en fullText
      charBase += para.length + 1;
    }

    return all;
  }

  /**
   * Clasifica un párrafo completo y devuelve sus anotaciones.
   *
   * La lógica se basa en si el párrafo contiene rayas de diálogo (—).
   * Si no tiene rayas → narración pura.
   * Si tiene rayas    → lo partimos por '—' y clasificamos cada segmento.
   */
  private annotateParagraph(text: string, base: number, counter: { n: number }): TextAnnotation[] {
    const out: TextAnnotation[] = [];

    if (!text.includes('—')) {
      // Párrafo sin diálogo → narración
      out.push({
        id: `a${counter.n++}`,
        type: 'narration',
        start: base,
        end: base + text.length,
      });
      this.extractNameRefs(text, base, out, counter);
      return out;
    }

    // ── Párrafo con raya de diálogo ───────────────────────────────────────
    //
    // Al partir "—A —B—. C." por '—' obtenemos ['', 'A ', 'B', '. C.']:
    //   partes[0] = '' (vacío, antes de la primera raya)
    //   partes[1] = 'A '  → segmento impar → diálogo
    //   partes[2] = 'B'   → segmento par  → beat si tiene verbo de atribución
    //   partes[3] = '. C.' → segmento impar → diálogo (continuación)
    //
    // Rastreamos la posición exacta acumulando (longitud de parte + 1 para la '—').

    const parts = text.split('—');
    let pos = 0; // posición actual dentro del párrafo (caracteres)

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const segStart = base + pos;
      const segEnd = segStart + part.length;

      if (part.trim()) {
        const type = this.classifySegment(part, i);
        out.push({ id: `a${counter.n++}`, type, start: segStart, end: segEnd });
        // Los nombres propios se detectan en todos los segmentos
        this.extractNameRefs(part, segStart, out, counter);
      }

      pos += part.length + 1; // +1 por la '—' que separa este segmento del siguiente
    }

    return out;
  }

  /**
   * Clasifica un segmento producido al partir por '—'.
   *
   * Reglas heurísticas para prosa literaria española:
   *  - Índice 0 (antes de la primera raya): narración contextual (raro pero posible).
   *  - Cualquier segmento con verbo de atribución: beat.
   *  - Índice impar (tras número impar de rayas): diálogo.
   *  - Índice par > 0 sin verbo de atribución: narración intercalada.
   */
  private classifySegment(text: string, index: number): AnnotationType {
    if (index === 0) return 'narration';
    if (ATTR_VERBS_RE.test(text)) return 'beat';
    if (index % 2 === 1) return 'dialogue';
    return 'narration';
  }

  /**
   * Detecta nombres propios compuestos en un fragmento de texto y los añade
   * como anotaciones de tipo 'character-ref'.
   *
   * IMPORTANTE: reseteamos lastIndex antes de cada uso porque NAME_RE es
   * una regex con flag /g — si no, el estado entre llamadas produce matches
   * incorrectos (bug clásico con regexes globales en JavaScript).
   */
  private extractNameRefs(
    text: string,
    base: number,
    out: TextAnnotation[],
    counter: { n: number },
  ): void {
    NAME_RE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = NAME_RE.exec(text)) !== null) {
      // Evitamos añadir una ref que ya está cubierta exactamente por otra
      // (puede ocurrir si el mismo nombre aparece como parte de un segmento
      // que ya fue anotado como 'beat' o 'dialogue' con la misma extensión)
      out.push({
        id: `a${counter.n++}`,
        type: 'character-ref',
        start: base + m.index,
        end: base + m.index + m[0].length,
        metadata: { name: m[0] },
      });
    }
  }
}
