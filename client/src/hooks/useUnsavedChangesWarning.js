import { useEffect } from 'react';

/**
 * Warns before a full page unload (tab close, hard reload) while a form is dirty.
 *
 * In-app navigation is blocked separately with react-router's `useBlocker` in the
 * form pages; this covers the cases the router cannot observe.
 *
 * @param {boolean} isDirty
 */
export function useUnsavedChangesWarning(isDirty) {
  useEffect(() => {
    if (!isDirty) return undefined;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      // Browsers show their own generic message; setting returnValue keeps the
      // prompt enabled in Chrome/Firefox.
      event.returnValue = '';
      return '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);
}

export default useUnsavedChangesWarning;
