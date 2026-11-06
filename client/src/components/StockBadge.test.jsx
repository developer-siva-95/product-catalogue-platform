import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import StockBadge from './StockBadge.jsx';

const label = () => screen.getByText(/stock|left|available/i).textContent;

describe('<StockBadge />', () => {
  it('shows the available quantity for an in-stock product', () => {
    render(<StockBadge stockStatus="in_stock" stock={42} />);

    expect(label()).toBe('42 in stock');
    expect(screen.getByTitle('42 in stock')).toHaveAttribute('data-stock-quantity', '42');
  });

  it('shows how many units are left when stock is low', () => {
    render(<StockBadge stockStatus="low_stock" stock={3} />);

    expect(label()).toBe('Low stock · 3 left');
  });

  it('never shows a quantity for an out-of-stock product', () => {
    render(<StockBadge stockStatus="out_of_stock" stock={0} />);

    expect(label()).toBe('Out of stock');
    expect(screen.getByTitle('Out of stock')).toHaveAttribute('data-stock-quantity', '0');
  });

  it('uses the detail wording with the same underlying status', () => {
    render(<StockBadge stockStatus="in_stock" stock={1240} variant="detail" />);

    expect(label()).toBe('In stock · 1,240 available');
  });

  it('formats large quantities rather than printing them raw', () => {
    render(<StockBadge stockStatus="in_stock" stock={125000} />);

    expect(label()).toBe('1,25,000 in stock');
  });

  it('degrades to a neutral label when the API omits the stock status', () => {
    render(<StockBadge stock={undefined} stockStatus={undefined} />);

    expect(label()).toBe('Stock unavailable');
    expect(screen.getByTitle('Stock unavailable').className).toContain('badge--neutral');
  });

  it('ignores a negative or non-numeric quantity instead of displaying it', () => {
    const { rerender } = render(<StockBadge stockStatus="in_stock" stock={-4} />);
    expect(label()).toBe('In stock');

    rerender(<StockBadge stockStatus="in_stock" stock="many" />);
    expect(label()).toBe('In stock');
  });

  it('derives only the unambiguous statuses when the API sends none', () => {
    const { rerender } = render(<StockBadge stock={0} />);
    expect(label()).toBe('Out of stock');

    rerender(<StockBadge stock={9} />);
    expect(label()).toBe('9 in stock');
  });

  it('exposes the status as a data attribute for styling and tests', () => {
    render(<StockBadge stockStatus="low_stock" stock={2} />);

    expect(screen.getByTitle('Low stock · 2 left')).toHaveAttribute(
      'data-stock-status',
      'low_stock',
    );
  });
});
