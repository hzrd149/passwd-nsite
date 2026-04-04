import { useEffect, useState } from "react";
import "./App.css";
import HomePage from "./pages/HomePage";
import DebugPage from "./pages/DebugPage";

type AppRoute = "home" | "debug";

function getRouteFromHash(hash: string): AppRoute {
  return hash === "#/debug" ? "debug" : "home";
}

function getRouteHref(route: AppRoute): string {
  return route === "debug" ? "#/debug" : "#/";
}

function App() {
  const [route, setRoute] = useState<AppRoute>(() =>
    getRouteFromHash(window.location.hash),
  );

  useEffect(() => {
    const handleHashChange = () => {
      setRoute(getRouteFromHash(window.location.hash));
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => {
      window.removeEventListener("hashchange", handleHashChange);
    };
  }, []);

  return (
    <main className="app-shell">
      <section className="panel intro-panel shell-header">
        <div className="section-copy">
          <p className="eyebrow">passwd nsite</p>
          <h1>Configure the site router and inspect archive tooling</h1>
          <p className="lede">
            The home view is the operational control surface for the service
            worker router. The debug view keeps the 7z test tools out of the
            main workflow.
          </p>
        </div>

        <nav className="route-nav" aria-label="Primary">
          <a
            className={`route-link${route === "home" ? " is-active" : ""}`}
            href={getRouteHref("home")}
          >
            Home
          </a>
          <a
            className={`route-link${route === "debug" ? " is-active" : ""}`}
            href={getRouteHref("debug")}
          >
            Debug
          </a>
        </nav>
      </section>

      {route === "debug" ? <DebugPage /> : <HomePage />}
    </main>
  );
}

export default App;
