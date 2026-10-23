import { Form, useActionData, useLoaderData } from "react-router";
import { contactByToken, unsubscribeByToken } from "../lifecycle.server";

// Public on purpose: an unsubscribe link has to work from an email client with
// no Shopify session, on a phone, months later. The token is random and grants
// nothing except turning this store's non-essential email off.
//
// Opening the link changes nothing; the opt-out is a POST. It used to happen in
// the loader, but mail scanners (Outlook Safe Links, Gmail link checks) open
// every link in a message, which opted merchants out without them ever
// clicking. One click on this page is still a single-page opt-out (CAN-SPAM),
// and mail clients' own one-click button POSTs here via List-Unsubscribe-Post.
export const loader = async ({ params }) => {
  const contact = await contactByToken(params.token);
  return {
    shop: contact?.shop || null,
    alreadyOut: contact ? !contact.optedIn : false,
  };
};

export const action = async ({ params }) => {
  const shop = await unsubscribeByToken(params.token);
  return { shop, done: !!shop };
};

const page = {
  fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, sans-serif",
  background: "#faf7f1",
  color: "#3a3128",
  minHeight: "100vh",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "24px",
  margin: 0,
};
const card = {
  background: "#fff",
  border: "1px solid #ece5db",
  borderRadius: 16,
  padding: "34px 32px",
  maxWidth: 460,
  width: "100%",
  textAlign: "center",
};
const h1 = { fontSize: 21, margin: "0 0 10px" };
const lead = { fontSize: 14.5, lineHeight: 1.65, color: "#6b6259", margin: "0 0 14px" };
const note = { fontSize: 13.5, lineHeight: 1.65, color: "#8a7d70", margin: 0 };
const button = {
  background: "#3a3128",
  color: "#fff",
  border: "none",
  borderRadius: 10,
  padding: "12px 22px",
  fontSize: 15,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
  margin: "4px 0 16px",
};

export default function Unsubscribe() {
  const { shop, alreadyOut } = useLoaderData();
  const result = useActionData();

  let body;
  if (result?.done || (shop && alreadyOut)) {
    body = (
      <>
        <h1 style={h1}>You&apos;re unsubscribed</h1>
        <p style={lead}>
          <b>{result?.shop || shop}</b> won&apos;t get tips or feedback requests
          from ZS StoreSync any more.
        </p>
        <p style={note}>
          You&apos;ll still get email about things you switched on yourself,
          like the results of a scheduled sync. Changed your mind? Turn it back
          on in ZS StoreSync → Settings.
        </p>
      </>
    );
  } else if (shop) {
    body = (
      <>
        <h1 style={h1}>Unsubscribe from ZS StoreSync email?</h1>
        <p style={lead}>
          <b>{shop}</b> will stop getting tips and feedback requests. Email you
          switched on yourself, like scheduled-sync results, isn&apos;t affected.
        </p>
        <Form method="post">
          <button type="submit" style={button}>
            Unsubscribe
          </button>
        </Form>
        <p style={note}>You can turn it back on any time in ZS StoreSync → Settings.</p>
      </>
    );
  } else {
    body = (
      <>
        <h1 style={h1}>This link isn&apos;t valid</h1>
        <p style={{ ...lead, margin: 0 }}>
          It may be incomplete or out of date. You can manage email in ZS
          StoreSync → Settings.
        </p>
      </>
    );
  }

  return (
    <div style={page}>
      <div style={card}>{body}</div>
    </div>
  );
}

// The token is in the URL: never let it travel as a Referer, and never let
// another site frame the one-button page to trick someone into clicking it.
export const headers = () => ({
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
});
