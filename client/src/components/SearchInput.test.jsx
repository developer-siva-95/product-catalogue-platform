import { describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchInput } from './SearchInput.jsx';

function renderInput(props = {}) {
  const onCommit = vi.fn();
  const view = render(<SearchInput value="" onCommit={onCommit} debounceMs={50} {...props} />);
  return { ...view, onCommit };
}

describe('<SearchInput />', () => {
  it('commits a typed term once the debounce settles', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderInput();

    await user.type(screen.getByRole('searchbox'), 'lamp');

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith('lamp'));
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('does not commit a term shorter than the minimum length', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderInput({ minLength: 2 });

    await user.type(screen.getByRole('searchbox'), 'l');
    // Let the debounce window elapse *inside* act() so the timer's (non-)update is
    // flushed deterministically instead of firing after the test has finished.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('still allows clearing down to an empty term', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderInput({ value: 'lamp' });

    await user.clear(screen.getByRole('searchbox'));

    await waitFor(() => expect(onCommit).toHaveBeenCalledWith(''));
  });

  it('does not clobber a value supplied from outside', async () => {
    // Regression: a deep link (?search=…) set the value from outside while the
    // debounce still held the previous (empty) value, which used to commit ""
    // and wipe the search straight after arriving.
    const onCommit = vi.fn();
    const { rerender } = render(<SearchInput value="" onCommit={onCommit} debounceMs={50} />);

    rerender(<SearchInput value="aurora" onCommit={onCommit} debounceMs={50} />);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('searchbox')).toHaveValue('aurora');
  });

  it('propagates an external clear without re-committing the old term', async () => {
    const onCommit = vi.fn();
    const { rerender } = render(<SearchInput value="aurora" onCommit={onCommit} debounceMs={50} />);

    rerender(<SearchInput value="" onCommit={onCommit} debounceMs={50} />);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('clears immediately from the clear button', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    const { rerender } = render(<SearchInput value="aurora" onCommit={onCommit} debounceMs={50} />);

    await user.click(screen.getByRole('button', { name: /clear search/i }));
    expect(onCommit).toHaveBeenCalledWith('');

    // The parent owns the value: once it propagates the clear, the box is empty.
    rerender(<SearchInput value="" onCommit={onCommit} debounceMs={50} />);
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });
});
