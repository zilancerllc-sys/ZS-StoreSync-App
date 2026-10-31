import { useFetcher } from "react-router";
import { Square } from "lucide-react";
import { useT } from "../i18n";

// Asks the running job to stop; the runner picks this up between items, so
// whatever was already copied stays on the store.
export function StopRunButton({ jobId }) {
  const t = useT();
  const fetcher = useFetcher();
  const asked = fetcher.state !== "idle" || fetcher.data?.ok;

  return (
    <fetcher.Form method="post" action={`/app/jobs/${jobId}`} style={{ margin: "10px 0" }}>
      <button type="submit" className="zs-btn zs-btn-ghost" disabled={asked}>
        <Square size={13} /> {asked ? t("Stopping…") : t("Stop this run")}
      </button>
    </fetcher.Form>
  );
}
