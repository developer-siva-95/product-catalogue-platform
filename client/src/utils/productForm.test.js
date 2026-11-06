import { describe, expect, it } from 'vitest';
import {
  buildProductFormData,
  EMPTY_PRODUCT_FORM,
  isProductFormDirty,
  productToFormValues,
  validateProductForm,
} from './productForm.js';

const valid = {
  title: 'Aurora Desk Lamp',
  description: 'A warm LED lamp with a dimmable head.',
  price: '2499',
  stock: '12',
  brand: 'brand-1',
  category: 'cat-1',
  sku: '',
  isActive: true,
};

describe('validateProductForm', () => {
  it('accepts a fully valid product', () => {
    expect(validateProductForm(valid)).toEqual({});
  });

  it('requires a title of at least two characters', () => {
    expect(validateProductForm({ ...valid, title: '   ' }).title).toBe('Title is required');
    expect(validateProductForm({ ...valid, title: 'A' }).title).toMatch(/at least 2/);
  });

  it('rejects an over-long title', () => {
    expect(validateProductForm({ ...valid, title: 'a'.repeat(161) }).title).toMatch(/at most 160/);
  });

  it('requires a description', () => {
    expect(validateProductForm({ ...valid, description: '  ' }).description).toBe(
      'Description is required',
    );
  });

  it('requires a numeric, non-negative price', () => {
    expect(validateProductForm({ ...valid, price: '' }).price).toBe('Price is required');
    expect(validateProductForm({ ...valid, price: 'abc' }).price).toBe('Price must be a number');
    expect(validateProductForm({ ...valid, price: '-1' }).price).toBe('Price cannot be negative');
    expect(validateProductForm({ ...valid, price: '0' }).price).toBeUndefined();
  });

  it('requires a whole, non-negative stock value', () => {
    expect(validateProductForm({ ...valid, stock: '' }).stock).toBe('Stock is required');
    expect(validateProductForm({ ...valid, stock: '1.5' }).stock).toBe(
      'Stock must be a whole number',
    );
    expect(validateProductForm({ ...valid, stock: '-2' }).stock).toBe('Stock cannot be negative');
  });

  it('requires a brand and a category', () => {
    const errors = validateProductForm({ ...valid, brand: '', category: '' });
    expect(errors.brand).toBe('Choose a brand');
    expect(errors.category).toBe('Choose a category');
  });

  it('validates the optional SKU format', () => {
    expect(validateProductForm({ ...valid, sku: 'AB' }).sku).toMatch(/3-32/);
    expect(validateProductForm({ ...valid, sku: 'AUR-1234' }).sku).toBeUndefined();
    expect(validateProductForm({ ...valid, sku: '' }).sku).toBeUndefined();
  });

  it('reports every invalid field at once', () => {
    const errors = validateProductForm({ ...EMPTY_PRODUCT_FORM });
    expect(Object.keys(errors).sort()).toEqual(
      ['brand', 'category', 'description', 'price', 'stock', 'title'].sort(),
    );
  });
});

describe('buildProductFormData', () => {
  it('serialises every field as multipart text', () => {
    const formData = buildProductFormData(valid);
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get('title')).toBe('Aurora Desk Lamp');
    expect(formData.get('price')).toBe('2499');
    expect(formData.get('isActive')).toBe('true');
    expect(formData.get('version')).toBeNull();
  });

  it('omits the version on create and includes it on update', () => {
    expect(buildProductFormData(valid, { version: null }).get('version')).toBeNull();
    expect(buildProductFormData(valid, { version: 3 }).get('version')).toBe('3');
  });

  it('uppercases the SKU and trims text', () => {
    const formData = buildProductFormData({ ...valid, title: '  Lamp  ', sku: ' aur-1 ' });
    expect(formData.get('title')).toBe('Lamp');
    expect(formData.get('sku')).toBe('AUR-1');
  });

  it('sends isActive=false for inactive products', () => {
    expect(buildProductFormData({ ...valid, isActive: false }).get('isActive')).toBe('false');
  });

  it('attaches the image only when one was chosen', () => {
    const file = new File(['x'], 'lamp.png', { type: 'image/png' });
    expect(buildProductFormData(valid).get('image')).toBeNull();
    expect(buildProductFormData(valid, { image: file }).get('image')).toBeInstanceOf(File);
  });
});

describe('productToFormValues', () => {
  it('maps an API product onto the form shape', () => {
    const values = productToFormValues({
      title: 'Lamp',
      description: 'Desc',
      price: 2499,
      stock: 4,
      brand: { id: 'b1', name: 'Aurora' },
      category: { id: 'c1', name: 'Lighting' },
      sku: 'AUR-1',
      isActive: false,
    });
    expect(values).toEqual({
      title: 'Lamp',
      description: 'Desc',
      price: 2499,
      stock: 4,
      brand: 'b1',
      category: 'c1',
      sku: 'AUR-1',
      isActive: false,
    });
  });

  it('returns an empty form for a missing product', () => {
    expect(productToFormValues(null)).toEqual(EMPTY_PRODUCT_FORM);
  });
});

describe('isProductFormDirty', () => {
  const initial = productToFormValues({
    title: 'Lamp',
    description: 'Desc',
    price: 100,
    stock: 1,
    brand: { id: 'b1' },
    category: { id: 'c1' },
    sku: 'AUR-1',
    isActive: true,
  });

  it('is clean when nothing changed', () => {
    expect(isProductFormDirty({ ...initial }, initial, null)).toBe(false);
  });

  it('ignores whitespace and numeric formatting differences', () => {
    expect(
      isProductFormDirty(
        { ...initial, title: ' Lamp ', price: ' 100 ', stock: '1' },
        initial,
        null,
      ),
    ).toBe(false);
  });

  it('detects a real edit', () => {
    expect(isProductFormDirty({ ...initial, name: undefined, price: '101' }, initial, null)).toBe(
      true,
    );
  });

  it('treats any newly selected image as a change', () => {
    expect(isProductFormDirty({ ...initial }, initial, new File(['x'], 'a.png'))).toBe(true);
  });
});
