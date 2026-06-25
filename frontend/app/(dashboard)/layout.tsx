import Link from "next/link";

const nav = [
  { href: "/campaigns", label: "Campaigns" },
  { href: "/leads", label: "Leads" },
  { href: "/review", label: "Review" },
  { href: "/analytics", label: "Analytics" },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-56 shrink-0 border-r bg-white p-4">
        <Link href="/" className="block text-lg font-semibold">
          OutboundOS
        </Link>
        <nav className="mt-6 space-y-1">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="block rounded px-3 py-2 text-sm hover:bg-gray-100">
              {n.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
