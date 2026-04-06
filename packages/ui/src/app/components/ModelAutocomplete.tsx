import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Props = {
  models: string[];
  value: string;
  onChange: (model: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
};

export function ModelAutocomplete({
  models,
  value,
  onChange,
  placeholder = 'Search models…',
  disabled = false,
  className = '',
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIndex, setHighlightIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const filtered = useMemo(() => {
    if (query.length === 0) return models;
    const lower = query.toLowerCase();
    return models.filter((m) => m.toLowerCase().includes(lower));
  }, [models, query]);

  const effectiveHighlightIndex = filtered.length === 0
    ? 0
    : Math.min(highlightIndex, filtered.length - 1);

  // Scroll highlighted item into view
  useEffect(() => {
    if (!open || !listRef.current) return;
    const item = listRef.current.children[effectiveHighlightIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [effectiveHighlightIndex, open]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const select = useCallback((model: string) => {
    onChange(model);
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  }, [onChange]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        setOpen(true);
        event.preventDefault();
      }
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setHighlightIndex((i) => {
          if (filtered.length === 0) return 0;
          const current = Math.min(i, filtered.length - 1);
          return current < filtered.length - 1 ? current + 1 : current;
        });
        break;
      case 'ArrowUp':
        event.preventDefault();
        setHighlightIndex((i) => {
          if (filtered.length === 0) return 0;
          const current = Math.min(i, filtered.length - 1);
          return current > 0 ? current - 1 : 0;
        });
        break;
      case 'Enter':
        event.preventDefault();
        if (filtered[effectiveHighlightIndex]) {
          select(filtered[effectiveHighlightIndex]);
        }
        break;
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        setQuery('');
        break;
      case 'Tab':
        setOpen(false);
        setQuery('');
        break;
    }
  };

  const displayValue = open && query.length > 0 ? query : value;

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      <input
        ref={inputRef}
        type="text"
        className="w-full rounded border border-slate-200 px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
        placeholder={value || placeholder}
        value={displayValue}
        disabled={disabled}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlightIndex(0);
          if (!open) setOpen(true);
        }}
        onFocus={(event) => {
          setOpen(true);
          setQuery('');
          setHighlightIndex(0);
          event.currentTarget.select();
        }}
        onKeyDown={handleKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-activedescendant={open && filtered[effectiveHighlightIndex] ? `model-option-${effectiveHighlightIndex}` : undefined}
      />
      {open && filtered.length > 0 && (
        <ul
          ref={listRef}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
          role="listbox"
        >
          {filtered.map((model, index) => (
            <li
              key={model}
              id={`model-option-${index}`}
              role="option"
              aria-selected={model === value}
              className={`cursor-pointer px-2 py-1.5 text-sm ${
                index === effectiveHighlightIndex
                  ? 'bg-blue-600 text-white'
                  : model === value
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                    : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'
              }`}
              onMouseEnter={() => setHighlightIndex(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                select(model);
              }}
            >
              {model}
            </li>
          ))}
        </ul>
      )}
      {open && filtered.length === 0 && query.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded border border-slate-200 bg-white px-2 py-2 text-xs text-slate-500 shadow-lg dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
          No matching models
        </div>
      )}
    </div>
  );
}
