import { useMemo, useState } from 'react';
import { formatCompact } from '../utils/format.js';

/**
 * One facet group (brands or categories).
 *
 * Large taxonomies are the only place a filter list gets unwieldy, so above
 * `searchThreshold` options the group grows a local search box: it filters the
 * options already in memory (the taxonomy endpoint returns the whole list, no
 * pagination), which is instant and adds no requests. Below the threshold the
 * search box is noise, so it is not rendered at all.
 *
 * The list itself is always scrollable (see `.filters__list`), which keeps the
 * sticky sidebar inside the viewport no matter how many options a deployment has.
 *
 * @param {{
 *   id: string,
 *   title: string,
 *   options: Array<{ id: string, name: string, activeProductCount?: number }>,
 *   selected: string,
 *   onToggle: (id: string) => void,
 *   loading?: boolean,
 *   emptyLabel?: string,
 *   searchThreshold?: number
 * }} props
 */
export function FilterFacet({
  id,
  title,
  options,
  selected,
  onToggle,
  loading = false,
  emptyLabel,
  searchThreshold = 8,
}) {
  const [query, setQuery] = useState('');
  const searchable = options.length > searchThreshold;

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) => option.name.toLowerCase().includes(term));
  }, [options, query]);

  const headingId = `facet-${id}`;
  const listId = `facet-${id}-options`;

  if (loading) {
    return (
      <div className="filters__group">
        <h3 id={headingId}>{title}</h3>
        <div className="stack">
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" style={{ width: '70%' }} />
        </div>
      </div>
    );
  }

  return (
    <div className="filters__group">
      <h3 id={headingId}>{title}</h3>

      {searchable ? (
        <input
          type="search"
          className="input input--sm filters__search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${title.toLowerCase()}…`}
          aria-label={`Search ${title.toLowerCase()} options`}
          aria-controls={listId}
          autoComplete="off"
        />
      ) : null}

      <div className="filters__list" id={listId} role="group" aria-labelledby={headingId}>
        {options.length === 0 && emptyLabel ? (
          <span className="text-subtle">{emptyLabel}</span>
        ) : null}
        {visible.length === 0 && options.length > 0 ? (
          <span className="text-subtle">
            No {title.toLowerCase()} matches “{query.trim()}”.
          </span>
        ) : null}
        {visible.map((option) => {
          const count = option.activeProductCount ?? 0;
          return (
            <button
              key={option.id}
              type="button"
              className="filter-option"
              aria-pressed={selected === option.id}
              // The visible count is decorative layout; spell it out here so the
              // accessible name stays readable ("Aurora, 4 products").
              aria-label={`${option.name}, ${count} product${count === 1 ? '' : 's'}`}
              onClick={() => onToggle(option.id)}
            >
              <span>{option.name}</span>
              <span className="filter-option__count" aria-hidden="true">
                {formatCompact(count)}
              </span>
            </button>
          );
        })}
      </div>

      {searchable && visible.length !== options.length ? (
        <p className="field__hint filters__meta" aria-live="polite">
          {visible.length} of {options.length} shown
        </p>
      ) : null}
    </div>
  );
}

export default FilterFacet;
