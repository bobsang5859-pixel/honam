import PDFDocument from 'pdfkit';
import path from 'path';
import fs from 'fs';

const FONTS_DIR = process.env.FONTS_DIR || path.join(__dirname, '..', '..', '..', 'fonts');

function getFontPath(): string {
  const fontPath = path.join(FONTS_DIR, 'NotoSansKR-Regular.ttf');
  if (fs.existsSync(fontPath)) return fontPath;
  // Fallback
  const altPath = path.join(FONTS_DIR, 'NotoSansKR-Regular.otf');
  if (fs.existsSync(altPath)) return altPath;
  throw new Error(`Font not found at ${fontPath}. Please place NotoSansKR-Regular.ttf in fonts/`);
}

function getBoldFontPath(): string {
  const fontPath = path.join(FONTS_DIR, 'NotoSansKR-Bold.ttf');
  if (fs.existsSync(fontPath)) return fontPath;
  return getFontPath(); // fallback to regular
}

export interface PdfOptions {
  title: string;
  subtitle?: string;
}

export function createPdfDocument(options: PdfOptions): PDFKit.PDFDocument {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    info: {
      Title: options.title,
      Author: '병원물품관리시스템',
    },
  });

  const fontPath = getFontPath();
  const boldFontPath = getBoldFontPath();

  doc.registerFont('Korean', fontPath);
  doc.registerFont('KoreanBold', boldFontPath);

  // Header
  doc.font('KoreanBold').fontSize(18).text(options.title, { align: 'center' });
  if (options.subtitle) {
    doc.font('Korean').fontSize(11).text(options.subtitle, { align: 'center' });
  }
  doc.moveDown(0.5);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
  doc.moveDown(0.5);

  return doc;
}

export function addTableHeader(doc: PDFKit.PDFDocument, headers: string[], colWidths: number[], startX: number = 50) {
  const y = doc.y;
  doc.font('KoreanBold').fontSize(9);

  // Header background
  doc.rect(startX, y - 2, colWidths.reduce((a, b) => a + b, 0), 18).fill('#f0f0f0');
  doc.fillColor('#000000');

  let x = startX;
  headers.forEach((h, i) => {
    doc.text(h, x + 3, y + 2, { width: colWidths[i] - 6, align: 'center' });
    x += colWidths[i];
  });
  doc.y = y + 20;
}

export function addTableRow(doc: PDFKit.PDFDocument, cells: string[], colWidths: number[], startX: number = 50) {
  // Check page break
  if (doc.y > 750) {
    doc.addPage();
    doc.y = 50;
  }

  const y = doc.y;
  doc.font('Korean').fontSize(8);

  let x = startX;
  cells.forEach((cell, i) => {
    doc.text(cell || '', x + 3, y + 2, { width: colWidths[i] - 6, align: 'center' });
    x += colWidths[i];
  });
  doc.y = y + 16;
}

export function addSection(doc: PDFKit.PDFDocument, title: string) {
  if (doc.y > 700) doc.addPage();
  doc.moveDown(0.5);
  doc.font('KoreanBold').fontSize(12).fillColor('#1e40af').text(title);
  doc.fillColor('#000000');
  doc.moveDown(0.3);
}

export function addText(doc: PDFKit.PDFDocument, text: string, options?: { bold?: boolean; size?: number }) {
  doc.font(options?.bold ? 'KoreanBold' : 'Korean')
    .fontSize(options?.size || 10)
    .text(text);
}

export function getFonts(): { regular: string; bold: string } {
  return { regular: getFontPath(), bold: getBoldFontPath() };
}

export function finalizePdf(doc: PDFKit.PDFDocument, outputPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);
    doc.end();

    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}
