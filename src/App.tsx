import { useEffect, useState } from "react";
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
    <main className="min-h-screen">
      {route === "debug" ? <DebugPage /> : <HomePage />}
      {route !== "debug" ? (
        <a
          className="fixed right-4 bottom-4 z-10 rounded-full border border-white/15 bg-slate-950/80 px-4 py-2 text-sm font-medium text-slate-200 shadow-lg shadow-slate-950/30 backdrop-blur transition hover:border-cyan-400/40 hover:text-white"
          href={getRouteHref("debug")}
        >
          Open debug view
        </a>
      ) : null}
    </main>
  );
}

export default App;
