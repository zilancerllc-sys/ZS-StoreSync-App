import { useState } from "react";
import { useFetcher } from "react-router";
import { RotateCcw } from "lucide-react";
import { useT } from "../i18n";

// Deletes what a run created, so it asks first and says exactly what that means.
export function UndoRunButton({ jobId, count }) {
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
        <RotateCcw size={14} /> {t("Undo this run")}
      </button>
    );
  }

  return (
    <div className="zs-banner err" style={{ display: "block", marginBottom: 12 }}>
      <p style={{ margin: "0 0 10px" }}>
        {t("This permanently deletes the {count} items this run created on this store, including any changes you made to them since. Items it updated or skipped stay as they are, and monthly usage isn't refunded.", { count })}
      </p>
      {error && <p style={{ margin: "0 0 10px", fontWeight: 600 }}>{t(error)}</p>}
      <fetcher.Form method="post" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input type="hidden" name="intent" value="undo" />
        <input type="hidden" name="jobId" value={jobId} />
        <button type="submit" className="zs-btn" disabled={busy}>
          {t("Delete {count} items", { count })}
        </button>
        <button
          type="button"
          className="zs-btn zs-btn-ghost"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          {t("Cancel")}
        </button>
      </fetcher.Form>
    </div>
  );
}
