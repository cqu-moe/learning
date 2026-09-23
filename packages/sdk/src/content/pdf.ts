import { PDFDocument } from 'pdf-lib';

export const RENDERER_VERSION = 'render-node/1.0.0';

/** Bounded image set → single PDF (S07): page/pixel budgets checked by callers first. */
export async function composePdfFromImages(images: Uint8Array[], title: string): Promise<{ pdfBytes: Uint8Array; rendererVersion: string; title: string }> {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  for (const image of images) {
    const png = await doc.embedPng(image);
    const page = doc.addPage([png.width, png.height]);
    page.drawImage(png, { x: 0, y: 0, width: png.width, height: png.height });
  }
  const bytes = await doc.save();
  return { pdfBytes: bytes, rendererVersion: RENDERER_VERSION, title };
}
