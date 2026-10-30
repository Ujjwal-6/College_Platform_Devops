/**
 * Public surface of the certificates module (reports, the dashboard). Import from here, not from the
 * module's internals. See docs/certificates-design.md.
 */
export { listForEvent as listCertificatesForEvent } from './repository.js';
export type { CertificateRecord } from './repository.js';
