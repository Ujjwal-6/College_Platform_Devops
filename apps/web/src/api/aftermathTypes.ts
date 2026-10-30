export interface MyFeedbackState {
  eligible: boolean;
  submitted: boolean;
  open: boolean;
  opensAt: string;
  closesAt: string;
}

export interface FeedbackResults {
  summary: {
    count: number;
    average: number | null;
    /** How many gave 1, 2, 3, 4 and 5 stars. */
    distribution: [number, number, number, number, number];
  };
  comments: { rating: number; comment: string }[];
}

export interface CertificateRow {
  id: string;
  eventId: string;
  holderName: string;
  code: string;
  status: 'pending' | 'ready';
  issuedAt: string;
  generatedAt: string | null;
  /** Set while the certificate is withdrawn. */
  revokedAt: string | null;
  /** Only sent to the people who manage the event. */
  revokeReason?: string | null;
}

export interface MyCertificate extends CertificateRow {
  event: { id: string; title: string; startAt: string; endAt: string } | null;
}

export interface EventCertificates {
  summary: { eligible: number; issued: number; ready: number; revoked: number; canIssue: boolean };
  data: CertificateRow[];
}

export interface WithdrawnCertificate {
  valid: false;
  revoked: true;
  code: string;
}

export interface CertificateTemplate {
  organizationName: string | null;
  signatoryName: string | null;
  signatoryTitle: string | null;
  hasLogo: boolean;
  hasSignature: boolean;
  updatedAt: string | null;
}

export interface VerifiedCertificate {
  valid: true;
  code: string;
  holderName: string;
  eventTitle: string;
  eventStartAt: string;
  eventEndAt: string;
  issuedAt: string;
}
