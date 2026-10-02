import { lexer, Token, Tokens } from 'marked';
import PDFDocument from 'pdfkit';

/**
 * Renders `report.md` to `report.pdf` with one fixed template (ADR-0001). The output depends
 * only on the Markdown: fonts are PDF standard fonts (never embedded) and the document dates
 * are fixed, so the same Report always renders to the same bytes.
 *
 * The standard fonts cover Latin-1 (WinAnsi); characters outside it do not render correctly.
 */
export function renderReportPdf(markdown: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 64, bottom: 64, left: 64, right: 64 },
    bufferPages: true,
    info: {
      Title: 'Report',
      Producer: 'ai-scanner',
      Creator: 'ai-scanner',
      CreationDate: FIXED_DATE,
      ModDate: FIXED_DATE,
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  try {
    new Writer(doc).blocks(lexer(markdown), 0);
    footer(doc);
    doc.end();
  } catch (e) {
    doc.destroy(e as Error);
  }
  return done;
}

const FIXED_DATE = new Date('2000-01-01T00:00:00.000Z');

const FONT = {
  regular: 'Helvetica',
  bold: 'Helvetica-Bold',
  italic: 'Helvetica-Oblique',
  boldItalic: 'Helvetica-BoldOblique',
  mono: 'Courier',
};
const BODY_SIZE = 10.5;
const HEADING_SIZES = [20, 16, 13.5, 12, 11, 10.5];
const INDENT = 16;
const TEXT_COLOR = '#1a1a1a';
const MUTED_COLOR = '#666666';
const RULE_COLOR = '#bbbbbb';
const CODE_BACKGROUND = '#f2f2f2';

interface Style {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}
interface Run extends Style {
  text: string;
}

function fontFor(style: Style): string {
  if (style.code) return FONT.mono;
  if (style.bold && style.italic) return FONT.boldItalic;
  if (style.bold) return FONT.bold;
  if (style.italic) return FONT.italic;
  return FONT.regular;
}

function checkbox(token: Tokens.Checkbox): string {
  return token.checked ? '[x] ' : '[ ] ';
}

/** Flattens inline tokens into styled text runs. */
function runs(tokens: Token[] | undefined, style: Style = {}): Run[] {
  const out: Run[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        out.push(...runs((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...runs((token as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'del':
        out.push(...runs((token as Tokens.Del).tokens, style));
        break;
      case 'codespan':
        out.push({ ...style, code: true, text: (token as Tokens.Codespan).text });
        break;
      case 'link': {
        const link = token as Tokens.Link;
        out.push(...runs(link.tokens, { ...style, link: link.href }));
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        out.push({ ...style, italic: true, text: `[image: ${image.text || image.href}]` });
        break;
      }
      case 'checkbox':
        out.push({ ...style, text: checkbox(token as Tokens.Checkbox) });
        break;
      case 'br':
        out.push({ ...style, text: '\n' });
        break;
      case 'text': {
        const text = token as Tokens.Text;
        if (text.tokens?.length) out.push(...runs(text.tokens, style));
        else out.push({ ...style, text: text.text });
        break;
      }
      default:
        // escape, html and anything unknown: shown as written.
        out.push({ ...style, text: 'text' in token ? String(token.text) : token.raw });
    }
  }
  return out;
}

class Writer {
  private color = TEXT_COLOR;
  /** Text the next paragraph starts with (a task list item's checkbox). */
  private prefix = '';

  constructor(private readonly doc: PDFKit.PDFDocument) {}

  private get left(): number {
    return this.doc.page.margins.left;
  }

  private get width(): number {
    return this.doc.page.width - this.doc.page.margins.left - this.doc.page.margins.right;
  }

  blocks(tokens: Token[], indent: number): void {
    for (const token of tokens) this.block(token, indent);
  }

  private block(token: Token, indent: number): void {
    const doc = this.doc;
    switch (token.type) {
      case 'space':
        break;
      case 'heading': {
        const heading = token as Tokens.Heading;
        doc.moveDown(heading.depth <= 2 ? 0.8 : 0.5);
        this.paragraph(runs(heading.tokens, { bold: true }), indent, HEADING_SIZES[heading.depth - 1]);
        if (heading.depth === 1) this.rule();
        doc.moveDown(0.3);
        break;
      }
      case 'paragraph':
        this.paragraph(runs((token as Tokens.Paragraph).tokens), indent, BODY_SIZE);
        doc.moveDown(0.5);
        break;
      case 'text': {
        // Block-level text only appears inside tight list items.
        const text = token as Tokens.Text;
        this.paragraph(text.tokens ? runs(text.tokens) : [{ text: text.text }], indent, BODY_SIZE);
        break;
      }
      case 'list':
        this.list(token as Tokens.List, indent);
        doc.moveDown(0.5);
        break;
      case 'blockquote': {
        const outer = this.color;
        this.color = MUTED_COLOR;
        this.blocks((token as Tokens.Blockquote).tokens, indent + INDENT);
        this.color = outer;
        break;
      }
      case 'code':
        this.code((token as Tokens.Code).text, indent);
        break;
      case 'table':
        this.table(token as Tokens.Table, indent);
        break;
      case 'hr':
        this.rule();
        doc.moveDown(0.5);
        break;
      default:
        // html and anything unknown: shown as written.
        this.paragraph([{ text: token.raw.trimEnd() }], indent, BODY_SIZE);
        doc.moveDown(0.5);
    }
  }

  private paragraph(content: Run[], indent: number, size: number): void {
    const doc = this.doc;
    const prefix = this.prefix;
    this.prefix = '';
    const parts = [{ text: prefix }, ...content].filter((r) => r.text !== '');
    if (parts.length === 0) return;
    doc.fontSize(size).fillColor(this.color);
    const x = this.left + indent;
    const width = this.width - indent;
    parts.forEach((run, i) => {
      const last = i === parts.length - 1;
      doc.font(fontFor(run));
      const options: PDFKit.Mixins.TextOptions = { width, continued: !last, link: run.link ?? null, underline: !!run.link };
      if (i === 0) doc.text(run.text, x, doc.y, options);
      else doc.text(run.text, options);
    });
  }

  private list(list: Tokens.List, indent: number): void {
    const doc = this.doc;
    const start = typeof list.start === 'number' ? list.start : 1;
    list.items.forEach((item, i) => {
      const marker = list.ordered ? `${start + i}.` : '•';
      doc.font(FONT.regular).fontSize(BODY_SIZE).fillColor(this.color);
      // The marker and its item's first line start on the same page: left to pdfkit, a marker at
      // the foot of a page moved alone to the next one, and its text, set back to the old y, to
      // the page after.
      if (doc.y + doc.currentLineHeight(true) > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const y = doc.y;
      doc.text(marker, this.left + indent, y, {
        width: INDENT,
        lineBreak: false,
      });
      doc.y = y;
      // Tight task items carry their checkbox as a block token; loose ones inside the paragraph.
      const [first, ...rest] = item.tokens;
      if (first?.type === 'checkbox') {
        this.prefix = checkbox(first as Tokens.Checkbox);
        this.blocks(rest, indent + INDENT);
      } else {
        this.blocks(item.tokens, indent + INDENT);
      }
      if (item.loose) doc.moveDown(0.3);
    });
  }

  private code(text: string, indent: number): void {
    const doc = this.doc;
    const x = this.left + indent;
    const width = this.width - indent;
    const padding = 6;
    doc.font(FONT.mono).fontSize(BODY_SIZE - 1.5);
    const height = doc.heightOfString(text, { width: width - 2 * padding }) + 2 * padding;
    if (doc.y + height > doc.page.height - doc.page.margins.bottom && height < doc.page.height / 2) doc.addPage();
    doc.save().rect(x, doc.y, width, height).fill(CODE_BACKGROUND).restore();
    doc.fillColor(TEXT_COLOR).text(text, x + padding, doc.y + padding, { width: width - 2 * padding });
    doc.y += padding;
    doc.moveDown(0.5);
  }

  private table(table: Tokens.Table, indent: number): void {
    const doc = this.doc;
    const x = this.left + indent;
    const columns = table.header.length;
    const columnWidth = (this.width - indent) / columns;
    const padding = 3;
    const row = (cells: Tokens.TableCell[], header: boolean) => {
      doc.fontSize(BODY_SIZE - 1);
      const texts = cells.map((c) => runs(c.tokens).map((r) => r.text).join(''));
      const height =
        Math.max(...texts.map((t) => doc.font(header ? FONT.bold : FONT.regular).heightOfString(t, { width: columnWidth - 2 * padding }))) +
        2 * padding;
      if (doc.y + height > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const top = doc.y;
      texts.forEach((t, i) => {
        doc.font(header ? FONT.bold : FONT.regular).text(t, x + i * columnWidth + padding, top + padding, {
          width: columnWidth - 2 * padding,
          align: table.align[i] ?? 'left',
        });
      });
      doc.save().lineWidth(0.5).strokeColor(RULE_COLOR);
      doc.moveTo(x, top + height).lineTo(x + columns * columnWidth, top + height).stroke();
      doc.restore();
      doc.x = x;
      doc.y = top + height;
    };
    row(table.header, true);
    for (const cells of table.rows) row(cells, false);
    doc.moveDown(0.5);
  }

  private rule(): void {
    const doc = this.doc;
    const y = doc.y + 2;
    doc.save().lineWidth(0.5).strokeColor(RULE_COLOR);
    doc.moveTo(this.left, y).lineTo(this.left + this.width, y).stroke();
    doc.restore();
    doc.y = y + 4;
  }
}

function footer(doc: PDFKit.PDFDocument): void {
  const { start, count } = doc.bufferedPageRange();
  for (let i = start; i < start + count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0; // writing inside the margin must not add a page
    doc
      .font(FONT.regular)
      .fontSize(8)
      .fillColor(MUTED_COLOR)
      .text(`Page ${i + 1} of ${count}`, doc.page.margins.left, doc.page.height - bottom / 2, {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
        align: 'center',
        lineBreak: false,
      });
    doc.page.margins.bottom = bottom;
  }
}
