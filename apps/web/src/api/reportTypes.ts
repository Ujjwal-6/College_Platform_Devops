export interface ReportVersion {
  id: string;
  version: number;
  reason: 'close' | 'manual';
  status: 'pending' | 'ready' | 'failed';
  requestedBy: string | null;
  createdAt: string;
  generatedAt: string | null;
}

export interface ReportPhoto {
  id: string;
  caption: string | null;
  createdAt: string;
}

export interface ReportOverview {
  inputs: { outcomes: string | null };
  photos: ReportPhoto[];
  reports: ReportVersion[];
  limits: { photoMaxBytes: number; photoMaxCount: number };
  can: { edit: boolean; generate: boolean };
}
