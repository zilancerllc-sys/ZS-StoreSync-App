// ═════════════════════════════════════════════════════════════════════════════
//  ZS StoreSync — UI translations (client side)
//
//  The English text IS the key: t("Start a Migration") looks that string up in
//  the merchant's dictionary and falls back to the English when it is missing.
//  That keeps call sites readable, means an untranslated string can never show
//  up as a raw key, and lets the client translate error messages that actions
//  return in English.
//
//  Placeholders use {name}: t("{n} items left", { n: 4 }).
//
//  Only the active language's dictionary reaches the browser — the app layout
//  loader picks it in messages.server.js and passes it down.
// ═════════════════════════════════════════════════════════════════════════════
import {
  Fragment,
  createContext,
  createElement,
  useContext,
  useMemo,
} from "react";

// Plain values are spliced into the string. When any value is a React element
// (t("Install on {shop}", { shop: <b>{shop}</b> })) the result is an array of
// nodes instead, so translators can move the bold part anywhere in a sentence.
function interpolate(str, vars) {
  if (!vars) return str;
  const hasNodes = Object.values(vars).some(
    (v) => v !== null && typeof v === "object",
  );
  if (!hasNodes) {
    return str.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  }
  return str.split(/(\{\w+\})/).map((part, i) => {
    const k = part.match(/^\{(\w+)\}$/)?.[1];
    if (!k || !(k in vars)) return part;
    const v = vars[k];
    return v !== null && typeof v === "object"
      ? createElement(Fragment, { key: i }, v)
      : String(v);
  });
}

export function makeT(messages) {
  return (text, vars) => interpolate(messages?.[text] || text, vars);
}

const I18nContext = createContext({ locale: "en", t: makeT({}) });

export function I18nProvider({ locale, messages, children }) {
  const value = useMemo(
    () => ({ locale, t: makeT(messages) }),
    [locale, messages],
  );
  return createElement(I18nContext.Provider, { value }, children);
}

export function useT() {
  return useContext(I18nContext).t;
}

export function useLocale() {
  return useContext(I18nContext).locale;
}
