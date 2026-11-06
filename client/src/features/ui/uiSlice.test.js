import { describe, expect, it } from 'vitest';
import reducer, {
  selectToasts,
  showError,
  showInfo,
  showSuccess,
  toastAdded,
  toastDismissed,
  toastsCleared,
} from './uiSlice.js';
import { createAppStore } from '../../app/store.js';

const initial = { toasts: [] };

describe('uiSlice', () => {
  it('starts with no toasts', () => {
    expect(reducer(undefined, { type: '@@init' })).toEqual(initial);
  });

  it('adds a toast with a unique id and defaults', () => {
    const state = reducer(initial, toastAdded({ message: 'Saved' }));
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0]).toMatchObject({ message: 'Saved', type: 'info', durationMs: 4500 });
    expect(state.toasts[0].id).toBeTruthy();
  });

  it('gives two toasts different ids', () => {
    const state = reducer(initial, toastAdded({ message: 'a' }));
    const next = reducer(state, toastAdded({ message: 'b' }));
    expect(next.toasts[0].id).not.toBe(next.toasts[1].id);
  });

  it('caps the queue at four toasts, dropping the oldest', () => {
    let state = initial;
    for (let index = 0; index < 6; index += 1) {
      state = reducer(state, toastAdded({ message: `toast-${index}` }));
    }
    expect(state.toasts).toHaveLength(4);
    expect(state.toasts[0].message).toBe('toast-2');
    expect(state.toasts.at(-1).message).toBe('toast-5');
  });

  it('dismisses a toast by id', () => {
    const state = reducer(initial, toastAdded({ message: 'a' }));
    const id = state.toasts[0].id;
    expect(reducer(state, toastDismissed(id)).toasts).toHaveLength(0);
  });

  it('ignores dismissing an unknown id', () => {
    const state = reducer(initial, toastAdded({ message: 'a' }));
    expect(reducer(state, toastDismissed('nope')).toasts).toHaveLength(1);
  });

  it('clears every toast', () => {
    const state = reducer(
      reducer(initial, toastAdded({ message: 'a' })),
      toastAdded({ message: 'b' }),
    );
    expect(reducer(state, toastsCleared()).toasts).toHaveLength(0);
  });

  it('exposes typed convenience thunks to the store', () => {
    const store = createAppStore();
    store.dispatch(showSuccess('saved'));
    store.dispatch(showError('failed'));
    store.dispatch(showInfo('note'));

    const toasts = selectToasts(store.getState());
    expect(toasts.map((toast) => toast.type)).toEqual(['success', 'error', 'info']);
  });
});
