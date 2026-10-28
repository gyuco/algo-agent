import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

export type SearchOption = {
  value: string;
  label: string;
  group?: string;
};

// A select with a text filter: the native one gets unwieldy with long lists of
// models and agents. Opens upward, since it sits under the composer.
export function SearchSelect({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
  searchPlaceholder,
  emptyText,
}: {
  value: string;
  options: SearchOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  ariaLabel: string;
  searchPlaceholder: string;
  emptyText: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.group?.toLowerCase().includes(q),
    );
  }, [options, query]);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  function show() {
    setQuery("");
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }

  function pick(option: SearchOption) {
    onChange(option.value);
    setOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const option = filtered[active];
      if (option) pick(option);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="search-select" ref={root}>
      <button
        type="button"
        className="search-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
      >
        <span>{selected?.label ?? ""}</span>
      </button>
      {open && (
        <div className="search-select-popover">
          <input
            autoFocus
            type="search"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={
              filtered[active] ? `${listId}-${active}` : undefined
            }
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <ul id={listId} role="listbox" ref={list} aria-label={ariaLabel}>
            {filtered.length === 0 && (
              <li className="search-select-empty">{emptyText}</li>
            )}
            {filtered.map((o, i) => (
              <li key={o.value} role="presentation">
                {o.group && o.group !== filtered[i - 1]?.group && (
                  <div className="search-select-group">{o.group}</div>
                )}
                <div
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={o.value === value}
                  className={i === active ? "active" : undefined}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(o)}
                >
                  {o.label}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
