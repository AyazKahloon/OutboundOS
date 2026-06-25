import Link from "next/link";

const links = [
  { href: "/campaigns", label: "Campaigns" },
  { href: "/leads", label: "Leads" },
  { href: "/review", label: "Review queue" },
  { href: "/analytics", label: "Analytics" },
];

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-2xl font-semibold">OutboundOS</h1>
      <p className="mt-2 text-gray-600">Multi-agent outbound marketing dashboard.</p>
      <ul className="mt-6 space-y-2">
        {links.map((l) => (
          <li key={l.href}>
            <Link className="text-blue-600 hover:underline" href={l.href}>
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
