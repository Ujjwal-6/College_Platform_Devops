const MANY = 14;

/**
 * A bar chart of one value per label. Short series are drawn as rows; long ones (a quarter of days)
 * as columns, with the same figures available as a table. The numbers are always text, so the chart
 * reads without the picture.
 */
export function Bars({
  rows,
  caption,
}: {
  rows: { label: string; value: number }[];
  caption: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const table = (
    <table aria-label={caption} className="bars">
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row">{r.label}</th>
            <td>
              <span
                className="bar"
                aria-hidden="true"
                style={{ width: `${(r.value / max) * 100}%` }}
              />
            </td>
            <td>{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  if (rows.length <= MANY) return table;

  const total = rows.reduce((n, r) => n + r.value, 0);
  return (
    <>
      <figure className="columns" aria-label={`${caption}: ${total} in total, highest ${max}`}>
        <div className="columns-plot" aria-hidden="true">
          {rows.map((r) => (
            <span
              key={r.label}
              className="column"
              title={`${r.label}: ${r.value}`}
              style={{ height: `${Math.max(2, (r.value / max) * 100)}%` }}
            />
          ))}
        </div>
        <figcaption>
          <span>{rows[0]!.label}</span>
          <span>highest {max}</span>
          <span>{rows[rows.length - 1]!.label}</span>
        </figcaption>
      </figure>
      <details>
        <summary>Show the figures as a table</summary>
        {table}
      </details>
    </>
  );
}
