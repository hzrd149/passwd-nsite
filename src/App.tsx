import { useEffect, useState } from "react";
import HomePage from "./pages/HomePage";
import DebugPage from "./pages/DebugPage";

type AppRoute = "home" | "debug";

function getRouteFromHash(hash: string): AppRoute {
  return hash === "#/debug" ? "debug" : "home";
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
    </main>
  );
}

export default App;
