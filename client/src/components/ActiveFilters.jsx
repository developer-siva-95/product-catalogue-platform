import { formatPrice } from '../utils/format.js';

/** Removable chips summarising the current filter set. */
export function ActiveFilters({
  search,
  brandName,
  categoryName,
  minPrice,
  maxPrice,
  onClearSearch,
  onClearBrand,
  onClearCategory,
  onClearPrice,
}) {
  const chips = [];

  if (search) {
    chips.push({ key: 'search', label: `“${search}”`, onClear: onClearSearch });
  }
  if (brandName) chips.push({ key: 'brand', label: brandName, onClear: onClearBrand });
  if (categoryName) chips.push({ key: 'category', label: categoryName, onClear: onClearCategory });
  if (minPrice !== '' || maxPrice !== '') {
    chips.push({
      key: 'price',
      label: `${formatPrice(minPrice || 0)} – ${maxPrice === '' ? 'any' : formatPrice(maxPrice)}`,
      onClear: onClearPrice,
    });
  }

  if (chips.length === 0) return null;

  return (
    <div className="active-filters" aria-label="Active filters">
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className="chip"
          onClick={chip.onClear}
          aria-label={`Remove filter ${chip.label}`}
        >
          {chip.label} <span aria-hidden="true">×</span>
        </button>
      ))}
    </div>
  );
}

export default ActiveFilters;
