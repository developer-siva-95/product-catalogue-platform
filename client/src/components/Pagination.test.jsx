import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { buildPageWindow, Pagination } from './Pagination.jsx';

describe('buildPageWindow', () => {
  it('returns every page when the total fits in the window', () => {
    expect(buildPageWindow(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(buildPageWindow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps first, last and the current neighbourhood for large totals', () => {
    expect(buildPageWindow(10, 40)).toEqual([1, 9, 10, 11, 40]);
  });

  it('never repeats a page number', () => {
    for (let page = 1; page <= 30; page += 1) {
      const pages = buildPageWindow(page, 30);
      expect(new Set(pages).size).toBe(pages.length);
      expect(pages[0]).toBe(1);
      expect(pages.at(-1)).toBe(30);
      expect(pages).toContain(page);
    }
  });

  it('collapses to first and last when the current page sits at an edge', () => {
    expect(buildPageWindow(1, 20)).toEqual([1, 2, 20]);
    expect(buildPageWindow(20, 20)).toEqual([1, 19, 20]);
  });

  it('handles a single page', () => {
    expect(buildPageWindow(1, 1)).toEqual([1]);
  });
});

describe('<Pagination />', () => {
  it('summarises a single page of results without controls', () => {
    render(<Pagination page={1} totalPages={1} total={7} onPageChange={() => {}} />);
    expect(screen.getByText('7 result(s)')).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });

  it('reports the current page and total', () => {
    render(<Pagination page={2} totalPages={5} total={47} onPageChange={() => {}} />);
    expect(screen.getByText('Page 2 of 5 · 47 result(s)')).toBeInTheDocument();
  });

  it('navigates to the next and previous page', async () => {
    const onPageChange = vi.fn();
    const user = userEvent.setup();
    render(<Pagination page={3} totalPages={5} total={50} onPageChange={onPageChange} />);

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(4);

    await user.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('disables the arrows at the extremes', () => {
    const { rerender } = render(
      <Pagination page={1} totalPages={3} total={30} onPageChange={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    rerender(<Pagination page={3} totalPages={3} total={30} onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('disables every control while a request is in flight', () => {
    render(<Pagination page={2} totalPages={4} total={40} onPageChange={() => {}} disabled />);
    for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  });

  it('marks the current page with aria-current', () => {
    render(<Pagination page={2} totalPages={4} total={40} onPageChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: 'Page 1' })).not.toHaveAttribute('aria-current');
  });

  it('jumps to a specific page', async () => {
    const onPageChange = vi.fn();
    const user = userEvent.setup();
    render(<Pagination page={1} totalPages={6} total={60} onPageChange={onPageChange} />);

    await user.click(screen.getByRole('button', { name: 'Page 4' }));
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it('shows ellipses instead of the skipped ranges', () => {
    const { container } = render(
      <Pagination page={10} totalPages={40} total={400} onPageChange={() => {}} />,
    );
    expect(container.querySelectorAll('.pagination__ellipsis')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Page 20' })).not.toBeInTheDocument();
  });
});
