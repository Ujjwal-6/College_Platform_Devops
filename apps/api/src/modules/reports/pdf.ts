import PDFDocument from 'pdfkit';

export interface ReportData {
  version: number;
  generatedAt: string;
  event: {
    title: string;
    description: string;
    category: string;
    when: string;
    venue: string | null;
    department: string | null;
    organizer: string | null;
    capacity: number | null;
    registration: string;
  };
  speakers: { name: string; designation: string | null; organization: string | null }[];
  attendance: {
    registered: number;
    checkedIn: number;
    /** checked in / registered, as a percentage with one decimal; null when nobody registered */
    ratePercent: number | null;
    noShows: number;
    walkIns: number;
    manualCheckIns: number;
    requireCheckOut: boolean;
    /** stayed to the end; only meaningful when check-out is required */
    completed: number;
    leftEarly: number;
    stillInside: number;
  };
  outcomes: string | null;
  photos: { data: Buffer; caption: string | null }[];
  feedback: {
    count: number;
    average: number | null;
    distribution: number[];
    comments: { rating: number; comment: string }[];
  };
  certificates: { issued: number; withdrawn: number };
}

const NOT_PROVIDED = '#7a7a7a';

/**
 * Draws the post-event report (A4, as many pages as it needs). Every section is always present; when
 * its information is missing it says so ("No photographs provided") instead of being left out or
 * failing. Text is drawn as text, so whatever a title or comment contains stays inert. Only the
 * standard PDF fonts are used (Western European characters). `compress` can be turned off so tests
 * can read the text.
 */
export function renderReport(data: ReportData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 50,
    bufferPages: true,
    compress: opts.compress ?? true,
    info: { Title: `Post-event report: ${data.event.title}`, Author: 'College Event Platform' },
  });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const bottom = () => doc.page.height - doc.page.margins.bottom;
  const ensure = (needed: number) => {
    if (doc.y + needed > bottom()) doc.addPage();
  };
  /** `keepWith` is the space the first thing under the heading needs, so a heading is never left alone at the foot of a page. */
  const heading = (text: string, keepWith = 0) => {
    ensure(70 + keepWith);
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(14).fillColor('#1a3a6b').text(text, left, doc.y, { width });
    doc
      .moveTo(left, doc.y + 2)
      .lineTo(left + width, doc.y + 2)
      .lineWidth(0.7)
      .stroke('#1a3a6b');
    doc.moveDown(0.6);
  };
  const body = (text: string) =>
    doc.font('Helvetica').fontSize(10.5).fillColor('#000000').text(text, left, doc.y, { width });
  const missing = (text: string) =>
    doc
      .font('Helvetica-Oblique')
      .fontSize(10.5)
      .fillColor(NOT_PROVIDED)
      .text(text, left, doc.y, { width });
  const field = (label: string, value: string | null) => {
    ensure(18);
    doc
      .font('Helvetica-Bold')
      .fontSize(10.5)
      .fillColor('#000000')
      .text(`${label}: `, left, doc.y, { continued: true, width });
    doc.font('Helvetica').text(value ?? 'Not provided', { width });
  };

  // ---- title -----------------------------------------------------------------------------------
  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor('#555555')
    .text('POST-EVENT REPORT', left, 50, { width });
  doc
    .moveDown(0.3)
    .fontSize(22)
    .fillColor('#000000')
    .text(data.event.title, left, doc.y, { width });
  doc.moveDown(0.3).font('Helvetica').fontSize(10).fillColor('#555555');
  doc.text(`Version ${data.version} · generated ${data.generatedAt}`, left, doc.y, { width });

  // ---- 1. event --------------------------------------------------------------------------------
  heading('1. Event details');
  field('When', data.event.when);
  field('Venue', data.event.venue);
  field('Department', data.event.department);
  field('Organizer', data.event.organizer);
  field('Category', data.event.category);
  field('Registration', data.event.registration);
  field('Seat limit', data.event.capacity === null ? 'No limit' : String(data.event.capacity));
  doc.moveDown(0.4);
  if (data.event.description.trim()) body(data.event.description);
  else missing('No description provided.');

  // ---- 2. speakers -----------------------------------------------------------------------------
  heading('2. Speakers');
  if (data.speakers.length === 0) missing('No speakers listed.');
  for (const s of data.speakers) {
    ensure(18);
    const detail = [s.designation, s.organization].filter(Boolean).join(', ');
    doc
      .font('Helvetica-Bold')
      .fontSize(10.5)
      .fillColor('#000000')
      .text(s.name, left, doc.y, { continued: !!detail, width });
    if (detail) doc.font('Helvetica').text(` — ${detail}`, { width });
  }

  // ---- 3. attendance ---------------------------------------------------------------------------
  heading('3. Attendance');
  const a = data.attendance;
  field('Registered', String(a.registered));
  field('Checked in', String(a.checkedIn));
  field(
    'Attendance rate',
    a.ratePercent === null
      ? 'Not available (nobody registered)'
      : `${a.ratePercent.toFixed(1)}% (checked in ÷ registered)`,
  );
  field('Registered but did not come', String(a.noShows));
  if (a.walkIns > 0) field('Walk-ins (not registered beforehand)', String(a.walkIns));
  if (a.manualCheckIns > 0) field('Checked in by hand', String(a.manualCheckIns));
  if (a.requireCheckOut) {
    field('Stayed to the end', String(a.completed));
    field('Left early', String(a.leftEarly));
    field('Not checked out', String(a.stillInside));
  } else {
    doc.moveDown(0.2);
    missing('Check-out was not required for this event, so staying to the end was not recorded.');
  }
  if (a.checkedIn === 0) {
    doc.moveDown(0.2);
    missing('No attendance was recorded for this event.');
  }

  // ---- 4. outcomes -----------------------------------------------------------------------------
  heading('4. Outcomes');
  if (data.outcomes) body(data.outcomes);
  else missing('No outcomes provided.');

  // ---- 5. photographs --------------------------------------------------------------------------
  heading('5. Photographs', data.photos.length > 0 ? 190 : 0);
  if (data.photos.length === 0) missing('No photographs provided.');
  const cell = (width - 20) / 2;
  let column = 0;
  let rowTop = doc.y;
  let skipped = 0;
  for (const photo of data.photos) {
    if (column === 0) {
      ensure(220);
      rowTop = doc.y;
    }
    const x = left + column * (cell + 20);
    try {
      doc.image(photo.data, x, rowTop, { fit: [cell, 170], align: 'center' });
    } catch {
      skipped++; // a photo that cannot be read must not stop the report
      continue;
    }
    if (photo.caption) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#444444')
        .text(photo.caption, x, rowTop + 174, { width: cell });
    }
    column = (column + 1) % 2;
    if (column === 0) doc.y = rowTop + 215;
  }
  if (column === 1) doc.y = rowTop + 215;
  if (skipped > 0) {
    doc.moveDown(0.4);
    missing(`${skipped} photograph${skipped === 1 ? '' : 's'} could not be included.`);
  }

  // ---- 6. feedback -----------------------------------------------------------------------------
  heading('6. Feedback');
  const f = data.feedback;
  if (f.count === 0) {
    missing('No feedback received.');
  } else {
    field('Responses', String(f.count));
    field(
      'Average rating',
      f.average === null ? 'Not available' : `${f.average.toFixed(1)} out of 5`,
    );
    for (let n = 5; n >= 1; n--) {
      field(`${n} ${n === 1 ? 'star' : 'stars'}`, String(f.distribution[n - 1] ?? 0));
    }
    if (f.comments.length > 0) {
      doc.moveDown(0.4);
      doc
        .font('Helvetica-Bold')
        .fontSize(10.5)
        .fillColor('#000000')
        .text('Comments (anonymous)', left, doc.y, { width });
      for (const c of f.comments) {
        ensure(30);
        doc
          .font('Helvetica')
          .fontSize(10)
          .fillColor('#000000')
          .text(`• (${c.rating}/5) ${c.comment}`, left + 8, doc.y + 3, { width: width - 8 });
      }
    }
  }

  // ---- 7. certificates -------------------------------------------------------------------------
  heading('7. Certificates');
  if (data.certificates.issued === 0) missing('No certificates have been issued yet.');
  else {
    field('Issued', String(data.certificates.issued));
    if (data.certificates.withdrawn > 0) field('Withdrawn', String(data.certificates.withdrawn));
  }

  // ---- footer on every page --------------------------------------------------------------------
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    // writing inside the bottom margin would otherwise start a new page
    const marginBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#777777')
      .text(
        `${data.event.title.slice(0, 80)} · post-event report v${data.version} · page ${i + 1} of ${range.count}`,
        left,
        doc.page.height - 36,
        { width, align: 'center', lineBreak: false },
      );
    doc.page.margins.bottom = marginBottom;
  }
  doc.end();
  return done;
}
