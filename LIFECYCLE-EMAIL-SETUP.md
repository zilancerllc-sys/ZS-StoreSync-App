# Lifecycle email — porting guide

Drop this file into another Zilancer app's folder and tell Claude Code:
**"Read LIFECYCLE-EMAIL-SETUP.md and implement it."**

It adds three emails:

| When | Email |
|---|---|
| On install | Welcome — what the app does, getting-started steps, other Zilancer apps |
| Install + 2 days | Feedback nudge → points at the in-app feedback box |
| Every 14 days after | Product update → other Zilancer apps |

Plus a Settings checkbox (on by default), a working unsubscribe link, and
automatic stop on uninstall.

Reference implementation: **ZS StoreSync**, at
`E:\Shopify-app-zilancer\ZS-StoreSync-App\zs-store-sync`. Paths below are
relative to the target app's own root (the folder with `package.json`).

---

## 0. Check these before starting

Stop and tell the user if any is false:

- [ ] React Router + `@shopify/shopify-app-react-router` (Shopify CLI template)
- [ ] Prisma with PostgreSQL, `app/db.server.js` exports the client
- [ ] `app/shopify.server.js` calls `shopifyApp({...})`
- [ ] Deployed somewhere that keeps a process alive (Fly, Render, Railway).
      **Vercel/Netlify serverless will not work** — nothing stays running to
      send the delayed emails. Say so rather than building something broken.
- [ ] A Resend account with the sending domain verified

---

## 1. Copy four files unchanged

From the StoreSync repo, copy verbatim — **do not edit them**:

```
app/notify.server.js              → app/notify.server.js
app/recommended-apps.js           → app/recommended-apps.js
app/lifecycle.server.js           → app/lifecycle.server.js
app/routes/unsubscribe.$token.jsx → app/routes/unsubscribe.$token.jsx
```

`notify.server.js` takes the app name from `APP_NAME` and all wording from its
callers, so it is identical in every app. `lifecycle.server.js` has one `COPY`
block at the top — that is the only thing you edit (step 5).

If the target app already has a `notify.server.js` or an email helper, merge
rather than overwrite: keep its existing sends, add these.

---

## 2. Database

Add to `prisma/schema.prisma`:

```prisma
model MerchantContact {
  id               String   @id @default(cuid())
  shop             String   @unique
  email            String?
  optedIn          Boolean  @default(true)
  unsubscribeToken String   @unique

  installedAt      DateTime @default(now())
  welcomeSentAt    DateTime?
  feedbackDueAt    DateTime?
  feedbackSentAt   DateTime?
  nextPromoAt      DateTime?
  lastPromoAt      DateTime?
  promoCount       Int      @default(0)
  unsubscribedAt   DateTime?
  uninstalledAt    DateTime?

  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@index([optedIn, feedbackDueAt])
  @@index([optedIn, nextPromoAt])
}
```

Then create the migration by hand (do **not** run `prisma migrate dev` against
production) in
`prisma/migrations/<YYYYMMDDHHMMSS>_merchant_contact/migration.sql` — copy the
SQL from StoreSync's
`prisma/migrations/20260808030000_merchant_contact/migration.sql`.

Apply with `npx prisma migrate deploy`, then `npx prisma generate`.

---

## 3. Wire five touch points

### 3a. Send the welcome on install — `app/shopify.server.js`

```js
import { onAppInstalled } from "./lifecycle.server";

const shopify = shopifyApp({
  // ...existing config...
  hooks: {
    afterAuth: async ({ session, admin }) => {
      try {
        await onAppInstalled({ shop: session.shop, admin });
      } catch (err) {
        console.error("[lifecycle] afterAuth failed:", err);
      }
    },
  },
});
```

If `hooks.afterAuth` already exists, add the call inside it. **Never let this
throw** — a failure here breaks the merchant's install.

### 3b. A heartbeat to send the delayed emails

Delayed mail needs something that runs on a timer. If the app already has one
(StoreSync's lives in `schedules.server.js`), add one line to it:

```js
import { runDueLifecycleEmails } from "./lifecycle.server";
// inside the existing setInterval:
runDueLifecycleEmails().then(
  (r) => { if (r.length) console.log("[lifecycle]", JSON.stringify(r)); },
  (err) => console.error("[lifecycle] tick failed:", err),
);
```

Otherwise create `app/lifecycle-ticker.server.js`:

```js
import { runDueLifecycleEmails } from "./lifecycle.server";

const TICK_MS = 60 * 1000;
const g = global;

export function startLifecycleTicker() {
  // Survive dev hot-reloads, which would otherwise stack up tickers.
  if (g.zsLifecycleTicker) return;
  g.zsLifecycleTicker = setInterval(() => {
    runDueLifecycleEmails().then(
      (r) => { if (r.length) console.log("[lifecycle]", JSON.stringify(r)); },
      (err) => console.error("[lifecycle] tick failed:", err),
    );
  }, TICK_MS);
  g.zsLifecycleTicker.unref?.();
}
```

and call it once from `app/entry.server.jsx`, at module scope:

```js
import { startLifecycleTicker } from "./lifecycle-ticker.server";
startLifecycleTicker();
```

**Running on several machines is fine.** Each due row is claimed by moving its
timestamp in the same `UPDATE` that checks it, so only one machine's update
matches. Do not add locking on top.

### 3c. Stop on uninstall — `app/routes/webhooks.app.uninstalled.jsx`

```js
import { onAppUninstalled } from "../lifecycle.server";
// inside the action:
await onAppUninstalled(shop);
```

### 3d. Delete on GDPR redact — `app/routes/webhooks.shop.redact.jsx`

```js
await db.merchantContact.deleteMany({ where: { shop } });
```

It holds an email address, so it must go with everything else.

### 3e. Settings checkbox

In the Settings route's **loader**:

```js
import { getEmailPreference } from "../lifecycle.server";

const pref = await getEmailPreference(session.shop);
// No row means the store installed before this existed — treat as on.
return { /* ...existing... */ emailOptedIn: pref ? pref.optedIn : true,
         notifyEmail: pref?.email || null };
```

In the **action**:

```js
import { setEmailPreference } from "../lifecycle.server";

const Q_SHOP_EMAIL = `#graphql
  { shop { email } }`;

if (form.get("intent") === "email-pref") {
  const optedIn = form.get("optedIn") === "on";
  let email = null;
  if (optedIn) {
    try {
      const res = await admin.graphql(Q_SHOP_EMAIL);
      email = (await res.json())?.data?.shop?.email || null;
    } catch { /* preference still saves */ }
  }
  await setEmailPreference(session.shop, optedIn, email);
  return { ok: true, prefSaved: true };
}
```

The action needs `admin`: `const { session, admin } = await authenticate.admin(request);`

And the form:

```jsx
<prefFetcher.Form method="post">
  <input type="hidden" name="intent" value="email-pref" />
  <label>
    <input type="checkbox" name="optedIn" defaultChecked={emailOptedIn} />
    <span>Send me product updates and tips</span>
  </label>
  <button>Save</button>
</prefFetcher.Form>
```

---

## 4. Environment

Set on the host (`fly secrets set …`), not in a committed file:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | Resend key (same one across apps) |
| `APP_NAME` | e.g. `ZS Wishlist` — appears in every subject and body |
| `FEEDBACK_FROM` | `ZS Wishlist <noreply@zilancer.com>` |
| `MAIL_REPLY_TO` | `contact@zilancer.com` |
| `MAIL_FROM_ADDRESS` | **Postal address** — required by CAN-SPAM, not an email |
| `SHOPIFY_APP_URL` | Already set; links in the emails use it |

If `RESEND_API_KEY` is missing, mail is skipped silently and nothing breaks.

---

## 5. Edit the COPY block

The only per-app editing. At the top of `app/lifecycle.server.js`:

```js
const COPY = {
  welcomeBlurb: "…one sentence: what this app does…",
  welcomeSteps: ["First thing", "Second thing"],   // [] to omit the box
  welcomeCta: { path: "/app", label: "Open the app" },
  welcomeClosing: "…optional line under the button…",
  feedbackExperience: "setup",   // "…how your ___ went"
  promoHeadline: "…",
  promoIntro: "…",
};
```

Write it for that app. Don't leave StoreSync's migration wording behind.

Also check `app/recommended-apps.js` — remove the app you're installing into
from its own list.

---

## 6. Test before deploying

**a. Templates, without sending.** Stub `fetch`, set `APP_NAME`, call each of
the three functions, and assert the HTML contains: the app name, the
unsubscribe link, the postal address, the app links. Copy StoreSync's approach.

**b. The claim, on a scratch row.** Insert a `MerchantContact` with
`feedbackDueAt` in the past, fire three concurrent claims, assert exactly one
wins:

```js
const claim = () => db.merchantContact.updateMany({
  where: { id, feedbackSentAt: null, feedbackDueAt: { lte: now } },
  data: { feedbackSentAt: now, feedbackDueAt: null },
});
const rs = await Promise.all([claim(), claim(), claim()]);
// exactly one r.count === 1
```

Delete the scratch row afterwards.

**c. A real send.** After deploying, from the host (so the Resend key is
present):

```
node -e "…import notify.server.js and call sendWelcomeEmail to your own address…"
```

Use a fake unsubscribe token so the link says "already used".

**d. The unsubscribe page** must return 200 with no Shopify session:

```
curl -s -o /dev/null -w "%{http_code}" https://<app>/unsubscribe/bogus
```

---

## Gotchas — each of these cost real time

**A one-line `` `#graphql {...}` `` template is an empty query.** `#` comments
to end of line, so the whole thing is a comment. Shopify returns 200 with
`syntax error, unexpected end of file`, and code reading `data?.x` sees
`undefined` and carries on as if the field were absent. Always:

```js
const Q = `#graphql
  { shop { email } }`;
```

This silently broke the welcome email and every Preview count in StoreSync.

**Shopify forbids marketing to merchants without consent.** Partner Program
Agreement 2.1.2: *"Unless Partner has secured the consent of the applicable
Merchant […] Partner will not email any Merchant […] whose email address they
have received via Shopify."* Only the welcome mail is ungated, as onboarding
for a service they just installed. Everything else checks `optedIn`.

**`optedIn` defaults to true** — opt-out. Fine under CAN-SPAM; GDPR does not
accept a pre-ticked box, so an EU/UK merchant has not really consented until
they tick it. To flip: default `optedIn` to `false` in the schema and drop
`defaultChecked` on the checkbox.

**Don't send from `noreply@` without a Reply-To.** An email asking for feedback
that bounces the reply is worse than not asking. `notify.server.js` already
sets `MAIL_REPLY_TO` on every merchant send.

**Fortnightly, not weekly.** Weekly promos to a small list buy unsubscribes and
spam reports, and a damaged sender reputation costs delivery of the
transactional mail merchants actually wanted.

**Stores that installed before this feature have no row.** They get no welcome
and no feedback nudge; `setEmailPreference` creates the row when they tick the
box, which is also the only consent-clean way to reach them.

---

## Definition of done

- [ ] `npm run build`, `npx eslint app/`, `npm run typecheck` all clean
- [ ] Migration applied, `MerchantContact` exists
- [ ] All six env variables set on the host
- [ ] `COPY` block rewritten for this app; app removed from its own
      `recommended-apps.js`
- [ ] Template test passes; claim test passes and cleans up after itself
- [ ] `/unsubscribe/<bogus>` returns 200 with no auth
- [ ] One real email received and read on a phone
- [ ] Privacy policy mentions the emails and the unsubscribe
