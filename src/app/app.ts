import { Component, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DocEditor } from './doc-editor/doc-editor';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, DocEditor],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly title = signal('midnat-frontend');
}
