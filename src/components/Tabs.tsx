import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
  panel: ReactNode;
}

interface TabsProps {
  label: string;
  items: TabItem[];
  selected: string;
  onSelect: (id: string) => void;
}

/**
 * WAI-ARIA tabs pattern: one tab stop for the whole tab list (roving
 * tabindex); Left/Right/Home/End move between tabs and select them.
 */
export function Tabs({ label, items, selected, onSelect }: TabsProps) {
  const baseId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === selected),
  );

  function focusTab(index: number) {
    const count = items.length;
    const next = ((index % count) + count) % count;
    const item = items[next];
    if (!item) return;
    onSelect(item.id);
    tabRefs.current[next]?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    switch (event.key) {
      case 'ArrowRight':
        focusTab(selectedIndex + 1);
        break;
      case 'ArrowLeft':
        focusTab(selectedIndex - 1);
        break;
      case 'Home':
        focusTab(0);
        break;
      case 'End':
        focusTab(items.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  const active = items[selectedIndex];

  return (
    <div className="tabs">
      <div role="tablist" aria-label={label} className="tablist" onKeyDown={onKeyDown}>
        {items.map((item, index) => {
          const isSelected = index === selectedIndex;
          return (
            <button
              key={item.id}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${item.id}`}
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel-${item.id}`}
              tabIndex={isSelected ? 0 : -1}
              className="tab"
              onClick={() => onSelect(item.id)}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {active && (
        <div
          role="tabpanel"
          id={`${baseId}-panel-${active.id}`}
          aria-labelledby={`${baseId}-tab-${active.id}`}
          tabIndex={0}
          className="tabpanel"
        >
          {active.panel}
        </div>
      )}
    </div>
  );
}
