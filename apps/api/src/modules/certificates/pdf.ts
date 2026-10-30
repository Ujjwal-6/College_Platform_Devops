import PDFDocument from 'pdfkit';

export interface CertificateData {
  holderName: string;
  eventTitle: string;
  when: string;
  /** The organising department, shown under the event title when known. */
  departmentName?: string | null;
  code: string;
  verifyUrl: string;
  qrPng: Buffer;
  /** The college's own look, supplied by an admin. Everything here is optional. */
  organizationName?: string | null;
  logo?: Buffer | null;
  signature?: Buffer | null;
  signatoryName?: string | null;
  signatoryTitle?: string | null;
}

/**
 * Draws the certificate of participation (A4 landscape). Only the standard PDF fonts are used, which
 * cover Western European characters; names in other scripts are not drawn correctly (a known limit).
 * A logo, an organisation name and a signature block appear only when the college supplied them.
 * `compress` can be turned off so tests can read the text.
 */
export function renderCertificate(
  data: CertificateData,
  opts: { compress?: boolean } = {},
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margin: 50,
    compress: opts.compress ?? true,
    info: { Title: `Certificate: ${data.eventTitle}`, Author: 'College Event Platform' },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const { width, height } = doc.page;
  const inner = width - 140;
  doc
    .lineWidth(3)
    .rect(30, 30, width - 60, height - 60)
    .stroke('#1a3a6b');
  doc
    .lineWidth(1)
    .rect(38, 38, width - 76, height - 76)
    .stroke('#1a3a6b');

  // Content flows down from the top; the optional logo and organisation name simply push it lower.
  let y = 62;
  if (data.logo) {
    doc.image(data.logo, (width - 200) / 2, y, { fit: [200, 52], align: 'center' });
    y += 58;
  }
  if (data.organizationName) {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#1a3a6b');
    doc.text(data.organizationName, 70, y, { width: inner, align: 'center' });
    y += 22;
  }
  y += data.logo || data.organizationName ? 4 : 18;

  doc.font('Times-Bold').fontSize(34).fillColor('#1a3a6b');
  doc.text('Certificate of Participation', 70, y, { width: inner, align: 'center' });
  y += 62;
  doc.font('Helvetica').fontSize(14).fillColor('#444444');
  doc.text('This is to certify that', 70, y, { width: inner, align: 'center' });
  y += 30;

  // long names get a smaller type so they stay on one line
  const nameSize = data.holderName.length > 40 ? 24 : data.holderName.length > 28 ? 30 : 38;
  doc.font('Times-Bold').fontSize(nameSize).fillColor('#000000');
  doc.text(data.holderName, 70, y, { width: inner, align: 'center' });
  y += nameSize + 28;

  doc.font('Helvetica').fontSize(14).fillColor('#444444');
  doc.text('took part in', 70, y, { width: inner, align: 'center' });
  y += 26;
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#000000');
  doc.text(data.eventTitle, 70, y, { width: inner, align: 'center' });
  doc.font('Helvetica').fontSize(13).fillColor('#444444');
  doc.text(data.when, 70, doc.y + 8, { width: inner, align: 'center' });
  if (data.departmentName) {
    doc.fontSize(12).text(`Organised by the Department of ${data.departmentName}`, 70, doc.y + 6, {
      width: inner,
      align: 'center',
    });
  }

  const qr = 90;
  doc.image(data.qrPng, 70, height - 70 - qr, { width: qr, height: qr });
  doc.font('Helvetica').fontSize(9).fillColor('#444444');
  doc.text(`Certificate code: ${data.code}`, 70 + qr + 14, height - 70 - qr + 24, { width: 330 });
  doc.text(`Verify at ${data.verifyUrl}`, 70 + qr + 14, doc.y + 4, { width: 330 });

  // Signature block, bottom right: the signature image over a line, then the name and title.
  if (data.signature || data.signatoryName || data.signatoryTitle) {
    const blockWidth = 200;
    const x = width - 70 - blockWidth;
    const base = height - 70 - qr + 52;
    if (data.signature) {
      doc.image(data.signature, x, base - 52, { fit: [blockWidth, 48], align: 'center' });
    }
    doc
      .lineWidth(0.7)
      .moveTo(x, base)
      .lineTo(x + blockWidth, base)
      .stroke('#444444');
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000000');
    let ty = base + 5;
    if (data.signatoryName) {
      doc.text(data.signatoryName, x, ty, { width: blockWidth, align: 'center' });
      ty = doc.y;
    }
    if (data.signatoryTitle) {
      doc.font('Helvetica').fontSize(9).fillColor('#444444');
      doc.text(data.signatoryTitle, x, ty, { width: blockWidth, align: 'center' });
    }
  }
  doc.end();
  return done;
}
