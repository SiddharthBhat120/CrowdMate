import { useState } from 'react';
import { getDisplayPrefs, setDisplayPrefs, type DisplayPrefs } from '../lib/storage';
import { onLinkClick } from '../lib/router';
import { Dialog } from './Dialog';

export function Header() {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState<DisplayPrefs>(getDisplayPrefs);

  function update(patch: Partial<DisplayPrefs>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    setDisplayPrefs(next);
  }

  return (
    <header className="topbar">
      <a href="/" className="brand" onClick={onLinkClick}>
        <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden="true">
          <path d="M5 8a3 3 0 0 1 3-3h16a3 3 0 0 1 3 3v4a4 4 0 0 0 0 8v4a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-4a4 4 0 0 0 0-8z" />
        </svg>
        CrowdMate
      </a>
      <button type="button" className="btn btn-quiet btn-small" onClick={() => setOpen(true)}>
        Display
      </button>
      <Dialog
        open={open}
        title="Display settings"
        onClose={() => setOpen(false)}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>
            Done
          </button>
        }
      >
        <fieldset className="choice-group">
          <legend>Text size</legend>
          <label className="choice">
            <input type="radio" name="text-size" checked={prefs.textSize === 'normal'} onChange={() => update({ textSize: 'normal' })} />
            Standard
          </label>
          <label className="choice">
            <input type="radio" name="text-size" checked={prefs.textSize === 'large'} onChange={() => update({ textSize: 'large' })} />
            Large
          </label>
        </fieldset>
        <fieldset className="choice-group">
          <legend>Contrast</legend>
          <label className="choice">
            <input type="radio" name="contrast" checked={prefs.contrast === 'normal'} onChange={() => update({ contrast: 'normal' })} />
            Standard
          </label>
          <label className="choice">
            <input type="radio" name="contrast" checked={prefs.contrast === 'high'} onChange={() => update({ contrast: 'high' })} />
            High, for bright sunlight
          </label>
        </fieldset>
      </Dialog>
    </header>
  );
}
