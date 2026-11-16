import { useState } from "react";
import { useFetcher } from "react-router";
import { History } from "lucide-react";
import { useT } from "../i18n";

// Puts back what a sync overwrote. Asks first and says what it does and doesn't do.
export function RestoreRunButton({ jobId, count }) {
  const t = useT();
  const fetcher = useFetcher();
  const [confirming, setConfirming] = useState(false);
  const busy = fetcher.state !== "idle";
  const error = fetcher.data?.error;

  if (!confirming) {
    return (
      <button
        type="button"
        className="zs-btn zs-btn-ghost"
        style={{ marginBottom: 12, marginLeft: 8 }}
        onClick={() => setConfirming(true)}
      >
        <History size={14} /> {count === 1 ? t("Restore 1 item") : t("Restore {count} items", { count })}
      </button>
    );
  }

  return (
    <div className="zs-banner info" style={{ display: "block", marginBottom: 12 }}>
      <p style={{ margin: "0 0 10px" }}>
        {count === 1
          ? t("This puts the product, collection or page this sync changed back the way they were just before it ran: titles, descriptions, tags, SEO, prices, SKUs, barcodes and the metafields it wrote. Changes you made to it since are overwritten. Items the sync created aren't touched (use Undo for those), and variants or options it added stay.")
          : t("This puts the {count} products, collections and pages this sync changed back the way they were just before it ran: titles, descriptions, tags, SEO, prices, SKUs, barcodes and the metafields it wrote. Changes you made to them since are overwritten. Items the sync created aren't touched (use Undo for those), and variants or options it added stay.", { count })}
      </p>
      {error && <p style={{ margin: "0 0 10px", fontWeight: 600 }}>{t(error)}</p>}
      <fetcher.Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input type="hidden" name="intent" value="restore" />
        <input type="hidden" name="jobId" value={jobId} />
        <button type="submit" className="zs-btn" disabled={busy}>
          {count === 1 ? t("Restore 1 item") : t("Restore {count} items", { count })}
        </button>
        <button type="button" className="zs-btn zs-btn-ghost" disabled={busy} onClick={() => setConfirming(false)}>
          {t("Cancel")}
        </button>
      </fetcher.Form>
    </div>
  );
}
