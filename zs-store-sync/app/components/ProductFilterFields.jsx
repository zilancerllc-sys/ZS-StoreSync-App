import { useState } from "react";
import { useFetcher } from "react-router";
import { useT } from "../i18n";

// Optional fields inside the Migrate and Sync run forms; read on the server by
// productFilterFromForm (app/lib/product-filter.js).
// What the two overwrite-style data types do, shown once they're picked.
export function NewTypeNotes({ picked }) {
  const t = useT();
  const note = { margin: "8px 0", fontSize: 12.5, color: "#8a7d70" };
  return (
    <>
      {picked.includes("inventory") && (
        <p style={note}>
          {t("Stock levels replaces the quantity on this store for matching variants. Locations are matched by name.")}
        </p>
      )}
      {picked.includes("translations") && (
        <p style={note}>
          {t("Translations copies products, collections, pages, blog posts and metaobjects, for languages enabled on both stores.")}
        </p>
      )}
    </>
  );
}

// Search the source store and tick exact products.
function ProductPicker({ sourceShop, input }) {
  const t = useT();
  const search = useFetcher();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState([]);
  const find = () =>
    search.load(`/app/source-products?source=${encodeURIComponent(sourceShop)}&q=${encodeURIComponent(q)}`);
  const toggle = (p) =>
    setPicked((list) =>
      list.some((x) => x.id === p.id) ? list.filter((x) => x.id !== p.id) : [...list, p].slice(0, 50),
    );
  const results = search.data?.products || [];
  const rows = [...picked, ...results.filter((r) => !picked.some((p) => p.id === r.id))];

  return (
    <div style={{ marginTop: 12 }}>
      <input type="hidden" name="filterIds" value={picked.map((p) => p.id).join(",")} />
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        {t("Pick exact products (up to 50)")}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          aria-label={t("Search by title")}
          placeholder={t("Search by title")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              find();
            }
          }}
          style={{ ...input, flex: "1 1 200px" }}
        />
        <button
          type="button"
          className="zs-btn zs-btn-ghost"
          disabled={!sourceShop || search.state !== "idle"}
          onClick={find}
        >
          {t("Search")}
        </button>
      </div>
      {rows.length > 0 && (
        <div style={{ marginTop: 8, maxHeight: 200, overflowY: "auto" }}>
          {rows.map((p) => (
            <label key={p.id} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 13 }}>
              <input
                type="checkbox"
                checked={picked.some((x) => x.id === p.id)}
                onChange={() => toggle(p)}
              />
              {p.title}
            </label>
          ))}
        </div>
      )}
      {search.data && results.length === 0 && (
        <p style={{ margin: "8px 0 0", fontSize: 12.5, color: "#8a7d70" }}>{t("No products found.")}</p>
      )}
    </div>
  );
}

export function ProductFilterFields({ sourceShop }) {
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
      <ProductPicker sourceShop={sourceShop} input={input} />
    </details>
  );
}
