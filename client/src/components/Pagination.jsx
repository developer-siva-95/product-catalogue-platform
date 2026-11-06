/**
 * Numbered pagination for the admin tables (offset strategy).
 *
 * Shows first/last plus a window around the current page with ellipses, so the
 * control stays a fixed width regardless of the total page count. Rendered as
 * real buttons in a nav landmark for keyboard/screen-reader users.
 */
export function buildPageWindow(currentPage, totalPages) {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  const pages = new Set([1, totalPages, currentPage]);
  if (currentPage - 1 > 1) pages.add(currentPage - 1);
  if (currentPage + 1 < totalPages) pages.add(currentPage + 1);
  return [...pages].sort((a, b) => a - b);
}

export function Pagination({ page, totalPages, total, onPageChange, disabled = false }) {
  if (totalPages <= 1) {
    return (
      <div className="pagination">
        <span className="text-subtle">{total} result(s)</span>
      </div>
    );
  }

  const windowPages = buildPageWindow(page, totalPages);
  const items = [];
  windowPages.forEach((pageNumber, index) => {
    if (index > 0 && pageNumber - windowPages[index - 1] > 1) {
      items.push({ type: 'ellipsis', key: `gap-${pageNumber}` });
    }
    items.push({ type: 'page', page: pageNumber, key: `page-${pageNumber}` });
  });

  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="text-subtle" aria-live="polite">
        Page {page} of {totalPages} · {total} result(s)
      </span>
      <div className="pagination__pages">
        <button
          type="button"
          className="pagination__page"
          onClick={() => onPageChange(page - 1)}
          disabled={disabled || page <= 1}
          aria-label="Previous page"
        >
          ‹
        </button>
        {items.map((item) =>
          item.type === 'ellipsis' ? (
            <span key={item.key} className="pagination__ellipsis" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={item.key}
              type="button"
              className="pagination__page"
              onClick={() => onPageChange(item.page)}
              aria-current={item.page === page ? 'true' : undefined}
              aria-label={`Page ${item.page}`}
              disabled={disabled}
            >
              {item.page}
            </button>
          ),
        )}
        <button
          type="button"
          className="pagination__page"
          onClick={() => onPageChange(page + 1)}
          disabled={disabled || page >= totalPages}
          aria-label="Next page"
        >
          ›
        </button>
      </div>
    </nav>
  );
}

export default Pagination;
