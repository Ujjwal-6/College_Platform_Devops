import PDFDocument from 'pdfkit';

export interface GatePassData {
  eventTitle: string;
  when: string;
  venue: string;
  holderName: string;
  teamName: string | null;
  validUntil: string;
  passId: string;
  qrPng: Buffer;
}

/**
 * Draws the gate pass (A5). Only the standard PDF fonts are used, which cover Western European
 * characters: names in other scripts (for example Devanagari) are not drawn correctly. `compress`
 * can be turned off so tests can read the text; the worker always uses the default.
 */
export function renderGatePass(
  data: GatePassData,
  opts: { compress?: boolean } = {},
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A5',
    margin: 40,
    compress: opts.compress ?? true,
    info: { Title: `Gate pass: ${data.eventTitle}`, Author: 'College Event Platform' },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const width = doc.page.width - 80;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#555555').text('EVENT GATE PASS', { width });
  doc.moveDown(0.4).fontSize(20).fillColor('#000000').text(data.eventTitle, { width });
  doc.moveDown(0.8).font('Helvetica').fontSize(11);
  const line = (label: string, value: string) => {
    doc.font('Helvetica-Bold').text(`${label}: `, { continued: true, width });
    doc.font('Helvetica').text(value, { width });
  };
  line('When', data.when);
  line('Venue', data.venue);
  line('Name', data.holderName);
  if (data.teamName) line('Team', data.teamName);

  const size = 200;
  doc.image(data.qrPng, (doc.page.width - size) / 2, doc.y + 18, { width: size, height: size });
  doc.y += size + 30;
  doc.font('Helvetica').fontSize(9).fillColor('#555555');
  doc.text(`Pass ${data.passId} · valid until ${data.validUntil} · one entry per pass`, 40, doc.y, {
    width,
    align: 'center',
  });
  doc.text('Show this QR code when you arrive and again when you leave. Do not share it.', {
    width,
    align: 'center',
  });
  doc.end();
  return done;
}
