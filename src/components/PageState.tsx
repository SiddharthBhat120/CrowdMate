import { useEffect, type ReactNode } from 'react';
import { onLinkClick } from '../lib/router';

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="page-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function Problem({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="problem">
      <h1>{title}</h1>
      {children}
      <p>
        <a href="/" onClick={onLinkClick}>
          Go to the home screen
        </a>
      </p>
    </section>
  );
}

/** Sets the browser tab title (also what screen readers announce on navigation). */
export function useTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} | CrowdMate` : 'CrowdMate';
  }, [title]);
}
