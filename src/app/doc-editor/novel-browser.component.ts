import { Component, EventEmitter, inject, OnInit, Output, signal } from '@angular/core';
import * as mammoth from 'mammoth';
import { NovelApiService } from './novel-api.service';
import { ChapterImportItem, ChapterSummary, Novel } from './novel.types';

/** Lo que emite el componente cuando el usuario abre un capítulo para editar. */
export interface ChapterSelection {
  novel: Novel;
  chapter: ChapterSummary;
}

/**
 * Estados de la navegación interna del browser:
 *  library  → cuadrícula de novelas
 *  detail   → lista de capítulos de una novela seleccionada
 */
type BrowserView = 'library' | 'detail';

// Paleta de colores para portadas generadas automáticamente
const COVER_COLORS = [
  '#4c1d95',
  '#1e3a5f',
  '#064e3b',
  '#7c2d12',
  '#1e1b4b',
  '#134e4a',
  '#831843',
  '#1c1917',
];

@Component({
  selector: 'app-novel-browser',
  standalone: true,
  templateUrl: './novel-browser.component.html',
  styleUrls: ['./novel-browser.component.scss'],
})
export class NovelBrowserComponent implements OnInit {
  /** Emitido cuando el usuario hace clic en un capítulo → el AppComponent abre el editor. */
  @Output() chapterSelected = new EventEmitter<ChapterSelection>();

  private readonly api = inject(NovelApiService);

  protected view = signal<BrowserView>('library');
  protected novels = signal<Novel[]>([]);
  protected selectedNovel = signal<Novel | null>(null);
  protected chapters = signal<ChapterSummary[]>([]);
  protected isLoading = signal(false);
  protected errorMsg = signal<string | null>(null);

  // ── Estado del modal de nueva novela ──────────────────────────────────────
  protected showNewModal = signal(false);
  protected newTitle = signal('');
  protected newAuthor = signal('');
  protected newDesc = signal('');
  protected newColor = signal(COVER_COLORS[0]);
  protected readonly coverColors = COVER_COLORS;

  ngOnInit(): void {
    this.loadNovels();
  }

  // ── Library ────────────────────────────────────────────────────────────────

  private async loadNovels(): Promise<void> {
    this.isLoading.set(true);
    try {
      this.novels.set(await this.api.listNovels());
    } catch (e) {
      this.errorMsg.set(`Error cargando novelas: ${e}`);
    } finally {
      this.isLoading.set(false);
    }
  }

  protected async openNovel(novel: Novel): Promise<void> {
    this.selectedNovel.set(novel);
    this.isLoading.set(true);
    this.errorMsg.set(null);
    try {
      const chapters = await this.api.listChapters(novel.id);
      this.chapters.set(chapters);
      this.view.set('detail');
    } catch (e) {
      this.errorMsg.set(`Error cargando capítulos: ${e}`);
    } finally {
      this.isLoading.set(false);
    }
  }

  protected backToLibrary(): void {
    this.view.set('library');
    this.selectedNovel.set(null);
    this.chapters.set([]);
    this.loadNovels(); // refresca por si cambió algo en el editor
  }

  protected selectChapter(chapter: ChapterSummary): void {
    const novel = this.selectedNovel();
    if (!novel) return;
    this.chapterSelected.emit({ novel, chapter });
  }

  // ── Crear novela vacía ─────────────────────────────────────────────────────

  protected openNewModal(): void {
    this.newTitle.set('');
    this.newAuthor.set('');
    this.newDesc.set('');
    this.newColor.set(COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)]);
    this.showNewModal.set(true);
  }

  protected async createBlankNovel(): Promise<void> {
    const title = this.newTitle().trim();
    if (!title) return;
    this.isLoading.set(true);
    try {
      const novel = await this.api.createNovel({
        title,
        author: this.newAuthor().trim(),
        description: this.newDesc().trim(),
        cover_color: this.newColor(),
      });
      this.showNewModal.set(false);
      await this.openNovel(novel);
    } catch (e) {
      this.errorMsg.set(`Error creando novela: ${e}`);
    } finally {
      this.isLoading.set(false);
    }
  }

  // ── Importar desde .docx ───────────────────────────────────────────────────

  protected async onDocxSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    input.value = ''; // reset para permitir re-seleccionar el mismo archivo

    if (!file.name.endsWith('.docx')) {
      this.errorMsg.set('Solo se aceptan archivos .docx');
      return;
    }

    this.isLoading.set(true);
    this.errorMsg.set(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const { value: html, messages } = await mammoth.convertToHtml({ arrayBuffer });
      if (messages.length) console.warn('Mammoth warnings:', messages);

      const rawChapters = this.splitDocxIntoChapters(html);

      // El título de la novela por defecto es el nombre del archivo sin extensión
      const novelTitle = file.name.replace(/\.docx$/i, '').replace(/[-_]/g, ' ');

      const novel = await this.api.importNovel({
        title: novelTitle,
        author: '',
        description: '',
        cover_color: COVER_COLORS[Math.floor(Math.random() * COVER_COLORS.length)],
        chapters: rawChapters,
      });

      await this.openNovel(novel);
    } catch (e) {
      this.errorMsg.set(`Error importando .docx: ${e}`);
    } finally {
      this.isLoading.set(false);
    }
  }

  /**
   * Divide el HTML de mammoth en capítulos basándose en los headings h1/h2/h3.
   *
   * Algoritmo:
   *  - Iteramos los hijos directos del cuerpo del DOM parseado.
   *  - Cada h1/h2/h3 inicia un nuevo capítulo; su texto se convierte en título.
   *  - El contenido entre dos headings forma el HTML del capítulo.
   *  - El contenido antes del primer heading forma un "Prólogo" (si no está vacío).
   *  - Si no hay ningún heading, todo el documento es un único capítulo.
   */
  private splitDocxIntoChapters(html: string): ChapterImportItem[] {
    const parser = new DOMParser();
    const parsed = parser.parseFromString(`<div>${html}</div>`, 'text/html');
    const root = parsed.body.firstElementChild!;

    const chapters: ChapterImportItem[] = [];
    let currentTitle = 'Prólogo';
    let currentNodes: string[] = [];

    const flush = () => {
      const bodyHtml = currentNodes.join('').trim();
      if (bodyHtml || chapters.length === 0) {
        // Extraemos texto plano del HTML para el LLM
        const tmp = parser.parseFromString(bodyHtml, 'text/html');
        chapters.push({
          title: currentTitle,
          content_html: bodyHtml,
          content_text: tmp.body.textContent?.trim() ?? '',
        });
      }
      currentNodes = [];
    };

    for (const child of Array.from(root.children)) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
        flush();
        currentTitle = child.textContent?.trim() || `Capítulo ${chapters.length + 1}`;
      } else {
        currentNodes.push((child as HTMLElement).outerHTML);
      }
    }

    flush(); // no olvidar el último capítulo

    // Si solo quedó un "Prólogo" vacío (docx sin headings), ajustamos el título
    if (chapters.length === 1 && chapters[0].title === 'Prólogo') {
      chapters[0].title = 'Capítulo 1';
    }

    return chapters;
  }

  // ── Editar metadatos de novela ─────────────────────────────────────────────

  protected async deleteNovel(novel: Novel, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (!confirm(`¿Eliminar «${novel.title}» y todos sus capítulos?`)) return;
    await this.api.deleteNovel(novel.id);
    this.loadNovels();
  }

  protected async addBlankChapter(): Promise<void> {
    const novel = this.selectedNovel();
    if (!novel) return;
    const title = `Capítulo ${this.chapters().length + 1}`;
    await this.api.createChapter(novel.id, { title });
    this.chapters.set(await this.api.listChapters(novel.id));
  }

  protected async deleteChapter(ch: ChapterSummary, event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (!confirm(`¿Eliminar el capítulo «${ch.title}»?`)) return;
    const novel = this.selectedNovel()!;
    await this.api.deleteChapter(novel.id, ch.id);
    this.chapters.set(await this.api.listChapters(novel.id));
  }

  /** Formatea un número de palabras en texto legible. */
  protected formatWords(n: number): string {
    if (!n) return 'vacío';
    if (n < 1000) return `${n} pal.`;
    return `${(n / 1000).toFixed(1)} k pal.`;
  }

  /** Formatea una fecha ISO en relativo legible. */
  protected relativeDate(iso: string): string {
    const d = new Date(iso + 'Z'); // SQLite no incluye Z
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'ahora mismo';
    if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
    if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
    return `hace ${Math.floor(s / 86400)} días`;
  }
}
