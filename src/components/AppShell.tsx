import { useCallback, useEffect, useState } from 'react';
import { CompanyWorkspace } from './CompanyWorkspace';
import { Sidebar } from './Sidebar';
import { NavContext } from '../context/NavContext';
import type { AskSeed, Route } from '../context/NavContext';
import { HomeDashboard } from '../sections/HomeDashboard';
import { TeachSection } from '../sections/TeachSection';
import { AskSection } from '../sections/AskSection';
import { TrustSection } from '../sections/TrustSection';
import { Icon } from './ui/Icon';

const ROUTES: Route[] = ['home', 'teach', 'ask', 'trust'];

function routeFromHash(): Route {
  const h = window.location.hash.replace('#/', '') as Route;
  return ROUTES.includes(h) ? h : 'home';
}

export function AppShell() {
  const [route, setRoute] = useState<Route>(routeFromHash);
  const [seed, setSeed] = useState<AskSeed | undefined>();
  const [toast, setToast] = useState<string | null>(null);

  const go = useCallback((r: Route, s?: AskSeed) => {
    setSeed(s);
    window.location.hash = `#/${r}`;
    setRoute(r);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // Keeps the browser back button honest.
  useEffect(() => {
    const onHash = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  return (
    <NavContext.Provider value={{ route, go, seed }}>
      <CompanyWorkspace>
        <Sidebar />
        <div className="main">
          <main className="page" key={route}>
            {route === 'home' && <HomeDashboard />}
            {route === 'teach' && <TeachSection onNote={setToast} />}
            {route === 'ask' && <AskSection seed={seed} onNote={setToast} />}
            {route === 'trust' && <TrustSection onNote={setToast} />}
          </main>
        </div>
        {toast && (
          <div className="toast" role="status">
            <span className="ok">
              <Icon name="check" size={16} />
            </span>
            {toast}
          </div>
        )}
      </CompanyWorkspace>
    </NavContext.Provider>
  );
}
