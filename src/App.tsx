import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { ConnectionBar } from './components/ConnectionBar';
import { Header } from './components/Header';
import { Loading, Problem } from './components/PageState';
import { useToast } from './components/Toast';
import { matchRoute, usePath } from './lib/router';
import { getSync } from './sync/hooks';
import { EventHub } from './pages/EventHub';
import { Finder } from './pages/Finder';
import { Home } from './pages/Home';
import { JoinQueue } from './pages/JoinQueue';
import { Ticket } from './pages/Ticket';

// Staff and family screens are split into separate files that load on demand.
// Someone scanning a QR code downloads only what the visitor screens need.
const Organizer = lazy(() => import('./pages/Organizer'));
const Counter = lazy(() => import('./pages/Counter'));
const TagOwner = lazy(() => import('./pages/TagOwner'));

type Params = Record<string, string>;

const ROUTES: [string, ComponentType<{ params: Params }>][] = [
  ['/', Home],
  ['/e/:eventId', EventHub],
  ['/q/:eventId/:queueId', JoinQueue],
  ['/ticket/:eventId/:ticketId', Ticket],
  ['/f/:eventId/:tagId', Finder],
  ['/organize/:eventId', Organizer],
  ['/counter/:eventId/:queueId', Counter],
  ['/tag/:eventId/:tagId', TagOwner],
];

function Router() {
  const path = usePath();
  for (const [pattern, Page] of ROUTES) {
    const params = matchRoute(pattern, path);
    if (params) {
      if (params.eventId) params.eventId = params.eventId.toUpperCase();
      return <Page key={path} params={params} />;
    }
  }
  return (
    <Problem title="Page not found">
      <p>This link doesn't lead anywhere in CrowdMate.</p>
    </Problem>
  );
}

export function App() {
  const toast = useToast();

  // Changes saved while offline can still be refused later (e.g. the queue closed meanwhile).
  useEffect(
    () =>
      getSync().onFailure((notice) => {
        toast.show(notice.message, { tone: 'error' });
      }),
    [toast],
  );

  return (
    <>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <Header />
      <ConnectionBar />
      <main id="main" className="main">
        <Suspense fallback={<Loading />}>
          <Router />
        </Suspense>
      </main>
    </>
  );
}
