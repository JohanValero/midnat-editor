import { Injectable } from '@angular/core';
import { AnnotationType, TextAnnotation } from './semantic-annotations.types';

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
      charBase += para.length + 1;
    }

    return all;
  }

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

    const parts = text.split('—');
    let pos = 0;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const segStart = base + pos;
      const segEnd = segStart + part.length;

      if (part.trim()) {
        const type = this.classifySegment(part, i);
        out.push({ id: `a${counter.n++}`, type, start: segStart, end: segEnd });
        this.extractNameRefs(part, segStart, out, counter);
      }

      pos += part.length + 1;
    }

    return out;
  }

  private classifySegment(text: string, index: number): AnnotationType {
    if (index === 0) return 'narration';
    if (ATTR_VERBS_RE.test(text)) return 'beat';
    if (index % 2 === 1) return 'dialogue';
    return 'narration';
  }

  private extractNameRefs(
    text: string,
    base: number,
    out: TextAnnotation[],
    counter: { n: number },
  ): void {
    NAME_RE.lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = NAME_RE.exec(text)) !== null) {
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
