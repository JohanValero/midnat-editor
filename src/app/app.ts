import { DocEditor } from './doc-editor/doc-editor';
import { Component, signal, ViewEncapsulation } from '@angular/core';
import { NovelBrowserComponent, ChapterSelection } from './doc-editor/novel-browser.component';
import { Chapter, Novel, toTextAnnotation } from './doc-editor/novel.types';
import { NovelApiService } from './doc-editor/novel-api.service';
import { inject } from '@angular/core';

type AppView = 'library' | 'editor';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [NovelBrowserComponent, DocEditor],
  encapsulation: ViewEncapsulation.None,
  // El template es deliberadamente mínimo: cada hijo gestiona su propio layout.
  template: `
    @if (view() === 'library') {
      <app-novel-browser (chapterSelected)="openChapter($event)" />
    }
    @if (view() === 'editor') {
      <app-doc-editor
        [novel]="activeNovel()"
        [chapter]="activeChapter()"
        (backToLibrary)="goToLibrary()"
      />
    }
  `,
})
export class App {
  private readonly api = inject(NovelApiService);

  protected view = signal<AppView>('library');
  protected activeNovel = signal<Novel | null>(null);
  protected activeChapter = signal<Chapter | null>(null);

  /**
   * Llamado cuando el usuario hace clic en un capítulo en el browser.
   * Carga el capítulo completo (con content_html y anotaciones) desde la BD
   * y abre el editor.
   */
  async openChapter({ novel, chapter }: ChapterSelection): Promise<void> {
    try {
      // El listado de capítulos no incluye content_html; lo cargamos ahora.
      const fullChapter = await this.api.getChapter(novel.id, chapter.id);
      this.activeNovel.set(novel);
      this.activeChapter.set(fullChapter);
      this.view.set('editor');
    } catch (err) {
      console.error('Error cargando capítulo:', err);
    }
  }

  protected goToLibrary(): void {
    this.view.set('library');
    this.activeNovel.set(null);
    this.activeChapter.set(null);
  }
}
