import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigation,
} from "react-router";

const routeLoaderStyles = `
  .zs-route-loader{position:fixed;top:0;left:0;right:0;height:3px;z-index:2147483647;pointer-events:none;background:transparent;overflow:hidden;opacity:0;transition:opacity .25s ease;}
  .zs-route-loader.on{opacity:1;}
  .zs-route-loader__bar{position:absolute;top:0;height:100%;width:35%;border-radius:0 3px 3px 0;background:linear-gradient(90deg,rgba(169,139,118,0) 0%,#A98B76 35%,#8C6E58 70%,#8A9163 100%);box-shadow:0 0 8px rgba(140,110,88,.5);left:-35%;}
  .zs-route-loader.on .zs-route-loader__bar{animation:zsRouteSlide 1.05s cubic-bezier(.45,0,.25,1) infinite;}
  @keyframes zsRouteSlide{0%{left:-35%;width:35%;}50%{width:45%;}100%{left:100%;width:35%;}}
  @media (prefers-reduced-motion: reduce){.zs-route-loader.on .zs-route-loader__bar{animation-duration:1.6s;}}
`;

function RouteLoader() {
  const navigation = useNavigation();
  const active = navigation.state !== "idle";
  return (
    <div className={`zs-route-loader ${active ? "on" : ""}`} aria-hidden="true">
      <div className="zs-route-loader__bar" />
    </div>
  );
}

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <style dangerouslySetInnerHTML={{ __html: routeLoaderStyles }} />
        <Meta />
        <Links />
      </head>
      <body>
        <RouteLoader />
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
