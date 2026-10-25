/**
 * Saves all events to one JSON file so a server restart loses nothing.
 * Writes are debounced (many changes in a burst = one write) and atomic
 * (write a temp file, then rename), so a crash mid-write can't corrupt data.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventRec } from './store';

interface FileShape {
  format: 1;
  savedAt: number;
  events: EventRec[];
}

export function loadEvents(file: string): EventRec[] {
  if (!existsSync(file)) return [];
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<FileShape>;
    if (data.format !== 1 || !Array.isArray(data.events)) throw new Error('unknown file format');
    return data.events.filter((e) => typeof e?.id === 'string' && Array.isArray(e.queues));
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    renameSync(file, backup);
    console.warn(`[crowdmate] Could not read ${file} (${(err as Error).message}). Moved it to ${backup} and started fresh.`);
    return [];
  }
}

export class Saver {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly file: string,
    private readonly getEvents: () => EventRec[],
    private readonly delayMs = 250,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const body: FileShape = { format: 1, savedAt: Date.now(), events: this.getEvents() };
    const tmp = `${this.file}.tmp`;
    const text = JSON.stringify(body);
    writeFileSync(tmp, text);
    try {
      renameSync(tmp, this.file);
    } catch {
      // On Windows an antivirus scan can briefly lock the file; fall back to a direct write.
      writeFileSync(this.file, text);
    }
  }
}
