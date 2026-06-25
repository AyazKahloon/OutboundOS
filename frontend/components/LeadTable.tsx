// Lead table. TODO: columns for name, company, title, status; row actions.
export interface LeadRow {
  id: string;
  fullName: string;
  companyName: string;
  title?: string | null;
  status: string;
}

export function LeadTable({ leads }: { leads: LeadRow[] }) {
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b text-gray-500">
          <th className="py-2">Name</th>
          <th>Company</th>
          <th>Title</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {leads.map((l) => (
          <tr key={l.id} className="border-b">
            <td className="py-2">{l.fullName}</td>
            <td>{l.companyName}</td>
            <td>{l.title ?? "—"}</td>
            <td>{l.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
