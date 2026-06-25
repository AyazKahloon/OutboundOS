// Lead table + CSV import. Leads are uploaded (no API sourcing).
// TODO: load the selected campaign's leads into LeadTable; let the user pick a campaign.
import { LeadImport } from "@/components/LeadImport";

export default function LeadsPage() {
  // TODO: replace with the campaign chosen in the UI.
  const campaignId = "REPLACE_WITH_CAMPAIGN_ID";

  return (
    <section className="space-y-6">
      <h1 className="text-xl font-semibold">Leads</h1>
      <LeadImport campaignId={campaignId} />
      <p className="text-gray-600">TODO: render LeadTable for the selected campaign.</p>
    </section>
  );
}
