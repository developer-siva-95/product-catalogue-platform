import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RefreshButton from './RefreshButton.jsx';

/**
 * The refresh control is the only thing standing between "click again" and
 * "two requests for one intent", so its contract is tested directly: one click,
 * one call; while a refresh is in flight it is disabled and shows a spinner.
 */
describe('<RefreshButton />', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders an accessible, enabled button with no spinner at rest', () => {
    render(<RefreshButton onRefresh={() => {}} />);

    const button = screen.getByRole('button', { name: /refresh/i });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('aria-busy', 'false');
    expect(button.querySelector('.btn__spinner')).toBeNull();
  });

  it('calls onRefresh exactly once per click', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<RefreshButton onRefresh={onRefresh} />);

    await user.click(screen.getByRole('button', { name: /refresh/i }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('shows a spinner, goes disabled and announces progress while fetching', () => {
    render(<RefreshButton onRefresh={() => {}} isFetching />);

    const button = screen.getByRole('button', { name: /refresh/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    // The visible indicator is the same spinner element the rest of the app uses.
    expect(button.querySelector('.btn__spinner')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(/refreshing/i);
  });

  it('cannot start a second request while the first is in flight', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const { rerender } = render(<RefreshButton onRefresh={onRefresh} />);

    const button = screen.getByRole('button', { name: /refresh/i });
    await user.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // The parent reports the request it just started; two more clicks land on a
    // disabled button and must not queue anything.
    rerender(<RefreshButton onRefresh={onRefresh} isFetching />);
    await user.click(screen.getByRole('button', { name: /refresh/i }));
    await user.click(screen.getByRole('button', { name: /refresh/i }));

    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('honours an external disabled flag without claiming to be busy', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(<RefreshButton onRefresh={onRefresh} disabled />);

    const button = screen.getByRole('button', { name: /refresh/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'false');

    await user.click(button);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
