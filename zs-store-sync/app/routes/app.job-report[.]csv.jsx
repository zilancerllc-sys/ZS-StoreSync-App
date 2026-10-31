// app/routes/app.job-report[.]csv.jsx
// Resource route: one run's log as a CSV, one row per line.
// Path: /app/job-report.csv?id=<job id>
// Scoped to the authenticated shop, like /app/jobs/:id.

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { parseLogsJson } from "../jobs.server";
import { csvCell } from "../lib/csv";

// Lets Excel read the file as UTF-8.
const BOM = String.fromCharCode(0xfeff);

const RESULT_BY_MARK = [
  ["✓", "created"],
  ["↻", "updated"],
  ["↪", "skipped"],
  ["✕", "failed"],
  ["⚠", "warning"],
  ["•", "would create"],
];

function reportRows(logs) {
  let dataType = "";
  const rows = [];
  for (const line of logs) {
    const m = /^\[([\d:]+)\] (.*)$/s.exec(line);
    const time = m ? m[1] : "";
    const text = (m ? m[2] : line).trim();
    const section = /^── (.+) ──$/.exec(text);
    if (section) {
      dataType = section[1].toLowerCase();
      continue;
    }
    const result = RESULT_BY_MARK.find(([mark]) => text.startsWith(mark))?.[1] || "info";
    rows.push([time, dataType, result, text]);
  }
  return rows;
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const id = new URL(request.url).searchParams.get("id") || "";

  const job = await db.migrationJob.findFirst({
    where: { id, shop: session.shop },
    select: { id: true, createdAt: true, logJson: true },
  });
  if (!job) throw new Response("Not found", { status: 404 });

  const rows = [["time_utc", "data_type", "result", "message"], ...reportRows(parseLogsJson(job.logJson))];
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");

  return new Response(`${BOM}${csv}\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="zs-storesync-report-${job.createdAt.toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
