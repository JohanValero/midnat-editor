import { ComponentFixture, TestBed } from '@angular/core/testing';

import { DocEditor } from './doc-editor';

describe('DocEditor', () => {
  let component: DocEditor;
  let fixture: ComponentFixture<DocEditor>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [DocEditor],
    }).compileComponents();

    fixture = TestBed.createComponent(DocEditor);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
