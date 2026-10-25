/**
 * Small settings kept in Web Storage (localStorage).
 * Storage can be blocked (private mode, strict settings) and throws in that
 * case, so every access is wrapped and falls back to an in-memory value.
 */
import { uid } from './ids';

const memory = new Map<string, string>();

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? null;
  }
}

function write(key: string, value: string) {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the in-memory copy still works for this visit */
  }
}

const KEYS = {
  deviceId: 'crowdmate.deviceId',
  name: 'crowdmate.name',
  textSize: 'crowdmate.textSize',
  contrast: 'crowdmate.contrast',
} as const;

/** A random id for this phone. It is the phone's proof of owning its tickets and tags. */
export function getDeviceId(): string {
  let id = read(KEYS.deviceId);
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = uid();
    write(KEYS.deviceId, id);
  }
  return id;
}

export const getSavedName = () => read(KEYS.name) ?? '';
export const setSavedName = (name: string) => write(KEYS.name, name);

export type TextSize = 'normal' | 'large';
export type Contrast = 'normal' | 'high';

export interface DisplayPrefs {
  textSize: TextSize;
  contrast: Contrast;
}

export function getDisplayPrefs(): DisplayPrefs {
  return {
    textSize: read(KEYS.textSize) === 'large' ? 'large' : 'normal',
    contrast: read(KEYS.contrast) === 'high' ? 'high' : 'normal',
  };
}

export function setDisplayPrefs(prefs: DisplayPrefs) {
  write(KEYS.textSize, prefs.textSize);
  write(KEYS.contrast, prefs.contrast);
  applyDisplayPrefs(prefs);
}

/** Reflect prefs on <html> so CSS can react. Called before React renders to avoid a flash. */
export function applyDisplayPrefs(prefs: DisplayPrefs = getDisplayPrefs()) {
  const root = document.documentElement;
  root.dataset.text = prefs.textSize;
  root.dataset.contrast = prefs.contrast;
}
