import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider, useToast } from './components/Toast';
import { applyDisplayPrefs } from './lib/storage';
import { registerServiceWorker } from './lib/sw';
import { getSync } from './sync/hooks';
import './styles.css';

// Apply text size / contrast before the first render so nothing flashes.
applyDisplayPrefs();
getSync().start();

let showUpdate: ((apply: () => void) => void) | null = null;
let pendingUpdate: (() => void) | null = null;
registerServiceWorker((apply) => {
  if (showUpdate) showUpdate(apply);
  else pendingUpdate = apply;
});

function UpdatePrompt() {
  const toast = useToast();
  useEffect(() => {
    showUpdate = (apply) =>
      toast.show('A new version of CrowdMate is ready.', {
        action: { label: 'Reload', run: apply },
        durationMs: 60_000,
      });
    if (pendingUpdate) {
      showUpdate(pendingUpdate);
      pendingUpdate = null;
    }
    return () => {
      showUpdate = null;
    };
  }, [toast]);
  return null;
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ToastProvider>
      <UpdatePrompt />
      <App />
    </ToastProvider>
  </StrictMode>,
);
