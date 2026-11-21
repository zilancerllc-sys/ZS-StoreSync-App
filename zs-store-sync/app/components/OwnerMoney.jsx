// app/components/OwnerMoney.jsx
// Owner dashboard money cards: Paid stores now / Trial stores / Per month /
// Earned total, from each counted store's own Shopify subscriptions
// (lib/owner-revenue.server.js). Same cards as ZS Bundles' owner dashboard.
// paidByPlan: the "paid" count beside Active stores (it reads the plan this
// app has cached, so it also counts paid plans still in their free trial).
// intro (optional): { n, endingWeek, nextEnd } -- stores on the app's own intro
// trial (not a Shopify charge), counted on the Trial stores card.

const money = (n, cur) => (cur && cur !== "USD"
  ? `${n.toFixed(2)} ${cur}`
  : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const day = (s) => (s ? new Date(s).toISOString().slice(0, 10) : "");

export default function OwnerMoney({ r, paidByPlan, intro }) {
  const data = r?.pending ? r.last : r;
  if (!data) {
    return (
      <div className="od-card">
        <p className="od-card-t">Money</p>
        <p className="od-note" style={{ fontSize: 13 }}>
          {r?.pending ? "Asking Shopify about each store's subscription. Reload in a minute." : "Could not read subscriptions from Shopify. Press Check stores to try again."}
        </p>
      </div>
    );
  }
  const cur = data.currency;
  const introN = intro?.n || 0;
  const trialN = (data.onTrial || 0) + introN;
  const endingWeek = (data.trialEndingWeek || 0) + (intro?.endingWeek || 0);
  const ends = [data.onTrial ? data.trialNextEnd : null, introN ? intro.nextEnd : null].filter(Boolean).sort();
  return (
    <>
      <div className="od-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}>
        <div className="od-stat">
          <div className="od-stat-l">Paid stores now</div>
          <div className="od-stat-v" style={{ color: data.paid ? "var(--zs-ok)" : undefined }}>{data.paid}</div>
          <div className="od-stat-h">charged by Shopify (free trials not counted)</div>
        </div>
        <div className="od-stat">
          <div className="od-stat-l">Trial stores</div>
          <div className="od-stat-v" style={{ color: trialN ? "var(--zs-warn)" : undefined }}>{trialN}</div>
          <div className="od-stat-h">
            {intro
              ? `${data.onTrial || 0} Shopify trial · ${introN} intro trial`
              : "on a paid plan’s Shopify free trial"}
            {trialN ? (endingWeek ? ` · ${endingWeek} end this week` : ends.length ? ` · first ends ${day(ends[0])}` : "") : ""}
          </div>
        </div>
        <div className="od-stat">
          <div className="od-stat-l">Per month</div>
          <div className="od-stat-v">{cur === null ? "mixed" : money(data.monthly, cur)}</div>
          <div className="od-stat-h">active paid plans, monthly price (annual ÷ 12)</div>
        </div>
        <div className="od-stat">
          <div className="od-stat-l">Earned total</div>
          <div className="od-stat-v">{cur === null ? "mixed" : money(data.earned, cur)}</div>
          <div className="od-stat-h">estimate, gross before Shopify’s revenue share</div>
        </div>
      </div>
      <p className="od-note" style={{ marginTop: -8, marginBottom: 16 }}>
        From each store’s own Shopify subscriptions, {r?.pending ? "last counted" : "counted"} {new Date(data.at).toISOString().slice(0, 16).replace("T", " ")} UTC
        ({data.checked} stores asked{data.failed.length ? `, ${data.failed.length} did not answer` : ""}; Check stores recounts).
        Leaves out test charges, trials not yet charged, and the stores left out above (our own, App Review, test, development, closed, frozen, dormant, uninstalled).
        Earned = for every charged subscription, the billing periods begun since its trial ended (ended plans: up to their last period end) × its price.
        Stores that uninstalled can no longer be asked, so what they paid before leaving is not included, and Shopify’s prorating on plan changes is not seen: Partners → Payouts has the exact amount.
        {data.unknownPast ? ` ${data.unknownPast} ended subscription(s) gave no period end and are not counted.` : ""}
        {intro ? " Intro trial = the app’s own free trial (no Shopify charge, not in Paid stores now)." : ""}
        {paidByPlan != null && paidByPlan !== data.paid ? ` The “${paidByPlan} paid” beside Active stores counts every paid plan, trials included.` : ""}
      </p>
    </>
  );
}
