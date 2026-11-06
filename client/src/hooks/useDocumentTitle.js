import { useEffect } from 'react';

const BASE_TITLE = 'Aurora Catalogue';

/** Keeps the document title in sync with the current view. */
export function useDocumentTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · ${BASE_TITLE}` : BASE_TITLE;
  }, [title]);
}

export default useDocumentTitle;
