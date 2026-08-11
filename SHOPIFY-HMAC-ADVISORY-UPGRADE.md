# Shopify App Proxy HMAC advisory — upgrade guide

Drop this file into another Zilancer app's folder and tell Claude Code:
**"Read SHOPIFY-HMAC-ADVISORY-UPGRADE.md and implement it."**

Shopify advisory **GHSA-3h8r-q86m-44c7** (published 10 Aug 2026): a HMAC
signature validation bug in **unauthenticated App Proxy requests**. Shopify
emailed the affected apps directly. The email is genuine — it was verified
against the GitHub advisory and the npm registry independently, without
following any link in it.

**Why this one matters more than a routine advisory:** the App Proxy is what
decides which shop a storefront request belongs to, and it is what makes
`logged_in_customer_id` trustworthy. Anything that reads or writes customer
data through `/apps/...` rests on that signature being checked properly.

Reference implementation: **ZS Wishlist**, commit `290bb0b`, at
`E:\Shopify-app-zilancer\ZS-Wishlist-App`. Paths below are relative to the
target app's own root (the folder with `package.json`).

---

## 0. Check before starting

Stop and tell the user if any of these is false:

- [ ] The app uses `@shopify/shopify-app-react-router`, `-remix`, or
      `-express` (check `package.json`)
- [ ] It is actually in a vulnerable range — run `npm ls` and compare:

| Package | Vulnerable | Fixed |
|---|---|---|
| `@shopify/shopify-api` | ≥7.6.0 <13.2.0 | **14.0.0** |
| `@shopify/shopify-app-express` | >2.2.3 <8.0.0 | **8.0.0** |
| `@shopify/shopify-app-react-router` | ≥0.1.0 <2.0.0 | **2.0.0** |
| `@shopify/shopify-app-remix` | ≥1.2.0 <4.2.2 | **5.0.0** |

- [ ] The working tree is clean and you know how the app deploys

If the app is on `shopify-app-remix`, the target is **5.0.0** and the
breaking changes below are for the React Router package — read that package's
own changelog instead of assuming these apply.

---

## 1. Upgrade

```bash
npm install @shopify/shopify-app-react-router@2.0.0
```

**Also bump the session storage adapter.** This is the step that is easy to
miss: `@shopify/shopify-app-session-storage-prisma@9.x` peer-depends on
`shopify-api ^13`, so leaving it behind puts the tree in conflict.

```bash
npm install @shopify/shopify-app-session-storage-prisma@10.0.0
```

Check whichever adapter the app actually uses — the version that pairs with
`shopify-app-session-storage ^6.0.0` is the one you want.

Confirm afterwards:

```bash
npm ls @shopify/shopify-app-react-router @shopify/shopify-api
npm audit --omit=dev     # the Shopify packages should no longer be listed
```

---

## 2. Breaking changes in 2.0.0

Four of them. Two bit ZS Wishlist; check all four against the target app.

### 2a. Node 22 is required

`engines` in the new package is `>=22.0.0`. Three places usually pin Node:

- `Dockerfile` — `FROM node:20-alpine` → `node:22-alpine`
- `.github/workflows/*.yml` — `node-version: '20'` → `'22'`
- `package.json` — `engines.node` → `>=22.12`

Miss any one and the build or the container fails at runtime, not at install.

### 2b. `AppProvider` no longer takes `embedded`

In v2 `AppProvider` accepts only `children` and `apiKey`, and it **always**
injects App Bridge. Two different situations:

**Admin routes** — just drop the prop:

```diff
- <AppProvider embedded apiKey={apiKey}>
+ <AppProvider apiKey={apiKey}>
```

**A login / non-embedded page** — `<AppProvider embedded={false}>` existed
precisely so App Bridge would *not* load. In v2 there is no way to ask for
that, and App Bridge has no business on a page that doesn't yet know which
shop it is talking to. Such a page usually only needs Polaris web components,
so load that script directly and drop `AppProvider`:

```jsx
const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris.js";
// ...
return (
  <>
    <script src={POLARIS_URL}></script>
    <s-page>…</s-page>
  </>
);
```

Note the official template still shows `embedded={false}` — it has not been
updated to v2, so don't take it as the v2 answer.

### 2c. Webhook `subTopic` is gone

`grep -rn "subTopic" app/`. If it appears, migrate to webhook filters.

### 2d. REST is gone from the package

`grep -rn "admin.rest\|\.rest\." app/`. If it appears, move those calls to
GraphQL or use the REST client directly.

---

## 3. The lock file has to be built on Linux

If the developer machine is Windows, `npm install` there drops the
linux-only optional dependencies, and `npm ci` in the Docker build then dies
with `Missing: @emnapi/... from lock file`. It fails in CI, not locally, so
it is easy to ship by accident.

No Linux machine is needed — **GitHub Actions is Linux.** Copy
`.github/workflows/relock.yml` from the ZS Wishlist repo. It is
`workflow_dispatch` only, regenerates the lock on Node 22, proves `npm ci`
works from it before committing, commits only `package-lock.json`, and takes
an optional `audit_fix` input.

Sequence:

1. Push the code changes. **This deploy will fail** on `npm ci` — expected,
   because the committed lock is still the Windows one. Say so in advance
   rather than letting the failure look like a surprise.
2. Run the relock workflow from the Actions tab.
3. It commits the corrected lock, which triggers a deploy that succeeds.

One caveat worth knowing: `npm install` may lift transitive dependencies
inside their semver ranges, and because the workflow commits, that deploys
itself. Fine when you are watching; don't fire it and walk away.

---

## 4. Verify before deploying

`npm run build`, `npx eslint app/`, `npm run typecheck` — all clean.

Then the part that actually matters. **Test the App Proxy signature
yourself**, since that is what the advisory is about. Boot the built server
locally and sign requests by hand:

```js
// signature = HMAC-SHA256 of the sorted "k=v" params concatenated, hex
function sign(params, secret) {
  const input = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("");
  return crypto.createHmac("sha256", secret).update(input).digest("hex");
}
```

Assert that every one of these is rejected:

- no `signature` at all
- a signature made with the wrong secret
- **a valid signature, then `logged_in_customer_id` edited afterwards**
- **a valid signature, then `shop` swapped afterwards**
- empty, `0`, `deadbeef`, `null`

The two in bold are the point of the exercise: a signature must not survive
having a parameter changed under it.

**Reading the result:** a correctly signed request will still fail locally
unless you have the real `SHOPIFY_API_SECRET`, because it gets past the HMAC
check and then dies on the session. Don't read that as a failed signature —
check the server log. The library prints
`App proxy request has invalid signature` for a genuine rejection, and prints
nothing of the sort when the signature passed and something later failed.

---

## 5. After deploying

Live-check the routes that go through the proxy, plus anything public:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "https://<app>/apps/<subpath>"
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://<app>/apps/<subpath>?shop=x.myshopify.com&logged_in_customer_id=999&signature=deadbeef"
```

Both must be `401`. Then load the app in a real store's admin — v2 changed
how App Bridge is injected, and a broken embed shows up there and nowhere
else.

---

## Gotchas — each of these cost real time

**The session storage adapter is the quiet one.** Everyone remembers the main
package. The adapter's peer range is what breaks the install.

**Node 22 is pinned in more places than you think.** The image, the CI
workflow, and `engines`. Two out of three still fails.

**A login page is not just "an admin page without the frame."** Dropping
`embedded={false}` by pasting `apiKey` in would put App Bridge on a page
whose whole job is to ask which shop the merchant wants — before there is a
shop to be embedded in.

**Don't reach for `npm audit fix --force` while you're here.** It pulls
majors. The remaining advisories after this upgrade are mostly transitive and
resolve inside their existing ranges; `--force` on top of a security upgrade
turns one reviewable change into an unreviewable one.

**A dependency the app doesn't import isn't a package to upgrade — it's one
to delete.** ZS Wishlist carried `nodemailer` with a high-severity advisory
while every email went through Resend. `grep` before upgrading anything.

**`npm audit fix` exits non-zero when anything is left that only `--force`
would move.** That is a report, not a failure. A CI step running it without
`|| true` throws away the patches it just applied — this cost a whole run.

**`npm audit fix` cannot fix react-router.** `@react-router/dev`, `node`,
`serve` and `fs-routes` each pin `react-router` to their own exact version,
so lifting `react-router` alone leaves the tree `invalid`. The family has to
move together, which means editing `package.json`, not just the lock:

```bash
npm install react-router@7.18.2 @react-router/dev@7.18.2 \
  @react-router/node@7.18.2 @react-router/serve@7.18.2 \
  @react-router/fs-routes@7.18.2
```

Check `npm ls react-router` for the word `invalid` afterwards.

**Judge what's left by where it ships, not by the count.** After this work ZS
Wishlist reported zero for `npm audit --omit=dev` while `npm audit` still
showed 28. The difference is devDependencies — graphql-codegen,
typescript-eslint, `@flydotio/dockerfile` — and the Dockerfile installs with
`--omit=dev`, so none of them reach the image. They all want a major.
Upgrading them buys nothing and risks the build.

---

## Definition of done

- [ ] `npm ls` shows `shopify-api@14.0.0` and the package at its fixed version
- [ ] `npm audit --omit=dev` no longer lists any `@shopify/*` package
- [ ] Node 22 in the image, the CI workflow, and `engines`
- [ ] No `embedded` prop left on any `AppProvider`
- [ ] `npm run build`, eslint, typecheck all clean
- [ ] Proxy signature test passes, including both tamper cases
- [ ] Lock file generated on Linux; `npm ci` proven to work from it
- [ ] Deployed, and the app loads inside a real store's admin
