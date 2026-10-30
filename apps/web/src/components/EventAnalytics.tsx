import { useEffect, useState } from 'react';
import { api } from '../api/client';
import type { EventAnalyticsData } from '../api/analyticsTypes';
import type { EventDetail } from '../api/types';
import { formatMoney } from '../lib/money';
import { Bars } from './Bars';

const percent = (n: number | null) => (n === null ? '—' : `${n}%`);

/** Numbers for one event, for its organizer, department staff and admins. */
export function EventAnalytics({ event }: { event: EventDetail }) {
  const [data, setData] = useState<EventAnalyticsData | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    api<{ data: EventAnalyticsData }>(`/events/${event.id}/analytics`)
      .then((r) => setData(r.data))
      .catch(() => setError(true));
  }, [event.id]);

  if (error) {
    return (
      <p role="alert" className="error">
        Could not load the analytics.
      </p>
    );
  }
  if (!data) return null;
  const { registrations, attendance, feedback, certificates, budget } = data;
  return (
    <>
      <h2>Analytics</h2>
      <ul>
        <li>{registrations.registered} registered</li>
        <li>
          {attendance.checkedIn} checked in · attendance rate {percent(attendance.ratePercent)}
          {attendance.noShows !== null ? ` · ${attendance.noShows} did not come` : ''}
        </li>
        <li>
          Feedback:{' '}
          {feedback.count === 0
            ? 'no responses yet'
            : `${feedback.average} out of 5 from ${feedback.count} ${feedback.count === 1 ? 'response' : 'responses'}`}
        </li>
        <li>{certificates.issued} certificates issued</li>
        {budget && (
          <li>
            Budget: planned {formatMoney(budget.estimateMinor)}, spent{' '}
            {formatMoney(budget.actualMinor)}
            {budget.overBudget ? ' (above plan)' : ''}
          </li>
        )}
      </ul>
      {registrations.perDay.length > 0 && (
        <Bars
          caption="Registrations per day"
          rows={registrations.perDay.map((d) => ({ label: d.date, value: d.count }))}
        />
      )}
    </>
  );
}
