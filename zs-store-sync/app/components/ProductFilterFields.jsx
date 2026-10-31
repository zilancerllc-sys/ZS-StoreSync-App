import { useT } from "../i18n";

// Optional fields inside the Migrate and Sync run forms; read on the server by
// productFilterFromForm (app/lib/product-filter.js).
export function ProductFilterFields() {
  const t = useT();
  const field = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 600 };
  const input = {
    padding: "9px 11px",
    border: "1px solid #e4dccf",
    borderRadius: 8,
    fontSize: 13,
    fontFamily: "inherit",
    background: "#fff",
    minWidth: 0,
  };

  return (
    <details style={{ margin: "12px 0", fontSize: 13 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>
        {t("Only copy some products (optional)")}
      </summary>
      <p style={{ margin: "8px 0 10px", fontSize: 12.5, color: "#8a7d70" }}>
        {t("Products must match every field you fill in. Leave all blank to copy all products. Applies to this run only.")}
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
        <label style={field}>
          {t("Tag")}
          <input name="filterTag" maxLength={100} style={input} />
        </label>
        <label style={field}>
          {t("Vendor")}
          <input name="filterVendor" maxLength={100} style={input} />
        </label>
        <label style={field}>
          {t("Product type")}
          <input name="filterType" maxLength={100} style={input} />
        </label>
        <label style={field}>
          {t("Status")}
          <select name="filterStatus" defaultValue="" style={input}>
            <option value="">{t("Any status")}</option>
            <option value="active">{t("Active")}</option>
            <option value="draft">{t("Draft")}</option>
            <option value="archived">{t("Archived")}</option>
          </select>
        </label>
      </div>
    </details>
  );
}
