import { redirect, Form, useLoaderData } from "react-router";
import { login } from "../../shopify.server";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>ZS StoreSync</h1>
        <p className={styles.text}>
          Move your store&apos;s content, store to store — copy products,
          collections, pages, files, blogs and more from one Shopify store into
          another. Duplicates skipped, nothing stored on our servers.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Store-to-store migration</strong>. Copy products (with
            variants and images), collections, pages, discounts, files, menus,
            redirects, metaobjects, metafields and blog posts in one run.
          </li>
          <li>
            <strong>Smart delta sync</strong>. Re-run anytime — items that
            already exist in the target store are detected live and skipped, so
            only new items are created.
          </li>
          <li>
            <strong>Secure pairing</strong>. A source store is only readable
            after its owner shares that store&apos;s private connection code.
          </li>
        </ul>
      </div>
    </div>
  );
}
