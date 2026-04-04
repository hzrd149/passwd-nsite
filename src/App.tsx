import { useEffect, useState } from "react";
import HomePage from "./pages/HomePage";
import PublishPage from "./pages/PublishPage";

type AppRoute = "home" | "publish";

function getRouteFromHash(hash: string): AppRoute {
  if (hash === "#/publish") {
    return "publish";
  }

  return "home";
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
      {route === "publish" ? <PublishPage /> : <HomePage />}
    </main>
  );
}

export default App;
