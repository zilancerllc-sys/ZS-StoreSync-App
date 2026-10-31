// app/routes/app.source-products.jsx
// Resource route for the product picker: searches a paired source store by title.
// Path: /app/source-products?source=<shop>&q=<text>

import { authenticate, unauthenticated } from "../shopify.server";
import { getVerifiedConnection } from "../connection.server";
import { gql } from "../migrator.server";

const Q_SEARCH = `#graphql
  query SearchSourceProducts($query: String) {
    products(first: 20, query: $query, sortKey: TITLE) {
      edges { node { id title status } }
    }
  }`;

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const sourceShop = url.searchParams.get("source") || "";
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);

  // SECURITY: only code-verified pairings may read the source store.
  const conn = await getVerifiedConnection(session.shop, sourceShop);
  if (!conn) throw new Response("Not found", { status: 404 });

  const { admin } = await unauthenticated.admin(sourceShop);
  const safe = q.replace(/[\\"*]/g, " ").trim();
  const data = await gql(admin, Q_SEARCH, { query: safe ? `title:*${safe}*` : null });
  return {
    products: (data?.products?.edges || []).map(({ node }) => ({
      id: node.id.split("/").pop(),
      title: node.title,
      status: node.status,
    })),
  };
};
