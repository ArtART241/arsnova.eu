import { Component, Directive, ElementRef, OnDestroy, inject, input } from '@angular/core';
import { Overlay, OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { renderMarkdownWithKatex } from '../../../shared/markdown-katex.util';

export interface WordCloudTooltipBlock {
  readonly kind: 'text' | 'markdown';
  readonly text?: string;
  readonly html?: SafeHtml;
}

@Component({
  selector: 'app-word-cloud-markdown-tooltip-panel',
  standalone: true,
  template: `
    <div class="word-cloud-markdown-tooltip" role="tooltip">
      @for (block of blocks; track $index) {
        @if (block.kind === 'text') {
          <p class="word-cloud-markdown-tooltip__text">{{ block.text }}</p>
        } @else {
          <div
            class="word-cloud-markdown-tooltip__markdown markdown-body"
            [innerHTML]="block.html"
          ></div>
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      max-width: min(34rem, calc(100vw - 1.5rem));
    }

    .word-cloud-markdown-tooltip {
      padding: 0.75rem 0.9rem;
      border-radius: 0.95rem;
      background: var(--mat-sys-inverse-surface);
      color: var(--mat-sys-inverse-on-surface);
      text-align: left;
      line-height: 1.5;
      font: var(--mat-sys-body-small);
    }

    .word-cloud-markdown-tooltip__text {
      margin: 0;
      white-space: pre-wrap;
    }

    .word-cloud-markdown-tooltip__markdown {
      margin-top: 0.35rem;
      overflow-x: auto;
    }

    .word-cloud-markdown-tooltip__text + .word-cloud-markdown-tooltip__text,
    .word-cloud-markdown-tooltip__markdown + .word-cloud-markdown-tooltip__markdown {
      margin-top: 0.35rem;
    }
  `,
})
export class WordCloudMarkdownTooltipPanel {
  blocks: readonly WordCloudTooltipBlock[] = [];
}

export function renderWordCloudTooltipMarkdown(source: string): string {
  return renderMarkdownWithKatex(source, {
    imagePolicy: 'external-https-and-app-assets',
    interactive: false,
    headingStartLevel: 6,
    escapeListMarkers: true,
  }).html;
}

@Directive({
  selector: '[appWordCloudMarkdownTooltip]',
  standalone: true,
  host: {
    '(mouseenter)': 'open()',
    '(mouseleave)': 'close()',
    '(focus)': 'open()',
    '(blur)': 'close()',
  },
})
export class WordCloudMarkdownTooltipDirective implements OnDestroy {
  readonly blocks = input<readonly WordCloudTooltipBlock[]>([], {
    alias: 'appWordCloudMarkdownTooltip',
  });

  private readonly overlay = inject(Overlay);
  private readonly host = inject(ElementRef<HTMLElement>);
  private overlayRef: OverlayRef | null = null;

  open(): void {
    const blocks = this.blocks().filter((block) =>
      block.kind === 'text' ? Boolean(block.text?.trim()) : Boolean(block.html),
    );
    if (blocks.length === 0) {
      this.close();
      return;
    }
    this.close();
    const position = this.overlay
      .position()
      .flexibleConnectedTo(this.host)
      .withFlexibleDimensions(false)
      .withPush(true)
      .withPositions([
        {
          originX: 'center',
          originY: 'bottom',
          overlayX: 'center',
          overlayY: 'top',
          offsetY: 8,
        },
        {
          originX: 'center',
          originY: 'top',
          overlayX: 'center',
          overlayY: 'bottom',
          offsetY: -8,
        },
      ]);
    this.overlayRef = this.overlay.create({
      positionStrategy: position,
      scrollStrategy: this.overlay.scrollStrategies.reposition(),
      panelClass: 'word-cloud-markdown-tooltip-pane',
    });
    const portal = new ComponentPortal(WordCloudMarkdownTooltipPanel);
    const ref = this.overlayRef.attach(portal);
    ref.instance.blocks = blocks;
    ref.changeDetectorRef.detectChanges();
  }

  close(): void {
    this.overlayRef?.dispose();
    this.overlayRef = null;
  }

  ngOnDestroy(): void {
    this.close();
  }
}

export function trustWordCloudTooltipHtml(sanitizer: DomSanitizer, source: string): SafeHtml {
  return sanitizer.bypassSecurityTrustHtml(renderWordCloudTooltipMarkdown(source));
}
