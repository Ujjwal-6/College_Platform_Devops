/** A plain bar chart: one bar per value, with the label and the value as text so it reads without the picture. */
export function Bars({
  rows,
  caption,
}: {
  rows: { label: string; value: number }[];
  caption: string;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
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
}
