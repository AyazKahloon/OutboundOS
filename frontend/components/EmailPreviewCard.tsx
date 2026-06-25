// Shows a draft email + approve button (used in the review queue).
"use client";

export interface EmailPreviewProps {
  leadId: string;
  recipientName: string;
  subject: string;
  body: string;
  onApprove?: (leadId: string) => void;
  onReject?: (leadId: string) => void;
}

export function EmailPreviewCard({ leadId, recipientName, subject, body, onApprove, onReject }: EmailPreviewProps) {
  return (
    <div className="rounded-lg border bg-white p-4 shadow-sm">
      <p className="text-xs text-gray-500">To: {recipientName}</p>
      <p className="mt-1 font-medium">{subject}</p>
      <pre className="mt-2 whitespace-pre-wrap text-sm text-gray-800">{body}</pre>
      <div className="mt-4 flex gap-2">
        <button
          className="rounded bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700"
          onClick={() => onApprove?.(leadId)}
        >
          Approve & send
        </button>
        <button
          className="rounded border px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={() => onReject?.(leadId)}
        >
          Reject
        </button>
      </div>
    </div>
  );
}
