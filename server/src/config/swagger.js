import swaggerUi from 'swagger-ui-express';
import { API_PREFIX } from '../constants/appConstants.js';
import env from './env.js';

/**
 * OpenAPI 3.0 specification + Swagger UI mount.
 *
 * The document is written by hand (rather than generated from JSDoc) so the
 * contract — including the dual pagination strategies, CSRF requirements and the
 * full error taxonomy — is reviewable in one place and stays accurate.
 *
 * `docs.test.js` asserts that every route registered on the Express app appears
 * here, so the spec cannot silently drift from the implementation.
 */

// ---------------------------------------------------------------- components
const errorResponse = (description, code) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorResponse' },
      example: {
        success: false,
        message: description,
        error: { code, details: null },
        requestId: '3f7df0c3-ec57-43c7-822f-98b807dbc87a',
      },
    },
  },
});

const standardErrors = (options = {}) => {
  const responses = {
    400: errorResponse('Validation failed or malformed request', 'VALIDATION_ERROR'),
    429: errorResponse('Rate limit exceeded', 'RATE_LIMITED'),
    500: errorResponse('Unexpected server error', 'INTERNAL_ERROR'),
  };
  if (options.auth !== false) {
    responses[401] = errorResponse('Authentication required or session invalid', 'AUTH_REQUIRED');
  }
  if (options.admin) {
    responses[403] = errorResponse(
      'Insufficient role, CSRF failure or password rotation required',
      'INSUFFICIENT_ROLE',
    );
  }
  Object.assign(responses, options.extra ?? {});
  return responses;
};

const envelope = (dataSchema, metaSchema) => ({
  type: 'object',
  required: ['success', 'message', 'data'],
  properties: {
    success: { type: 'boolean', example: true },
    message: { type: 'string', example: 'OK' },
    data: dataSchema,
    ...(metaSchema ? { meta: metaSchema } : {}),
    requestId: { type: 'string', format: 'uuid' },
  },
});

const csrfHeader = {
  name: 'X-CSRF-Token',
  in: 'header',
  required: true,
  description:
    'Double-submit CSRF token. Obtain it from `GET /api/v1/auth/csrf` (or the login response) and echo the exact value from the readable `csrf_token` cookie. Required for every unsafe method (POST/PUT/PATCH/DELETE) when authenticating with cookies; Bearer-token clients are exempt.',
  schema: { type: 'string' },
};

const idParam = {
  name: 'id',
  in: 'path',
  required: true,
  description: 'MongoDB ObjectId (24 hex characters) or, for public reads, a slug.',
  schema: { type: 'string', example: '6511f0aaa1b2c3d4e5f60718' },
};

const query = (params) => params;

// ---------------------------------------------------------------- schemas
const schemas = {
  ErrorResponse: {
    type: 'object',
    required: ['success', 'message', 'error'],
    properties: {
      success: { type: 'boolean', example: false },
      message: { type: 'string' },
      error: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            example: 'VALIDATION_ERROR',
            description:
              'Stable machine-readable code. Values include VALIDATION_ERROR, AUTH_REQUIRED, SESSION_INVALID, SESSION_REVOKED, INVALID_CREDENTIALS, ACCOUNT_LOCKED, CSRF_TOKEN_MISSING, CSRF_TOKEN_MISMATCH, CSRF_TOKEN_INVALID, INSUFFICIENT_ROLE, PASSWORD_CHANGE_REQUIRED, ROUTE_NOT_FOUND, DUPLICATE_KEY, STALE_RESOURCE, INSUFFICIENT_STOCK, CURSOR_INVALID, CURSOR_SORT_MISMATCH, CURSOR_FILTER_MISMATCH, FILE_TOO_LARGE, UNSUPPORTED_FILE_TYPE, MIME_TYPE_MISMATCH, BRAND_IN_USE, CATEGORY_IN_USE, RATE_LIMITED, INTERNAL_ERROR.',
          },
          details: { nullable: true },
          stack: {
            type: 'string',
            description: 'Development builds only — never present in production.',
          },
        },
      },
      requestId: { type: 'string', format: 'uuid' },
    },
  },
  User: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6511f0aaa1b2c3d4e5f60718' },
      name: { type: 'string', example: 'Catalogue Administrator' },
      email: { type: 'string', format: 'email', example: 'admin@catalogue.com' },
      role: { type: 'string', enum: ['admin', 'customer'] },
      isActive: { type: 'boolean' },
      mustChangePassword: { type: 'boolean' },
      lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  Brand: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string', example: 'Aurora' },
      slug: { type: 'string', example: 'aurora' },
      description: { type: 'string' },
      logo: { type: 'string' },
      productCount: { type: 'integer', example: 4 },
      activeProductCount: { type: 'integer', example: 3 },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  Category: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string', example: 'Audio' },
      slug: { type: 'string', example: 'audio' },
      description: { type: 'string' },
      productCount: { type: 'integer' },
      activeProductCount: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ProductRef: {
    type: 'object',
    nullable: true,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      slug: { type: 'string' },
    },
  },
  Product: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '6511f0aaa1b2c3d4e5f60718' },
      title: { type: 'string', example: 'Aurora Studio Wireless Headphones' },
      slug: { type: 'string', example: 'aurora-studio-wireless-headphones' },
      sku: { type: 'string', nullable: true, example: 'AUD-7K2M9QX' },
      price: { type: 'number', example: 24990 },
      stock: { type: 'integer', example: 34 },
      inStock: { type: 'boolean' },
      stockStatus: { type: 'string', enum: ['in_stock', 'low_stock', 'out_of_stock'] },
      description: { type: 'string' },
      image: { type: 'string', example: '/uploads/products/1793881376956-24ce563fa7119ef5.jpg' },
      thumbnail: { type: 'string' },
      brand: { $ref: '#/components/schemas/ProductRef' },
      category: { $ref: '#/components/schemas/ProductRef' },
      isActive: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  AdminProduct: {
    allOf: [
      { $ref: '#/components/schemas/Product' },
      {
        type: 'object',
        required: ['version'],
        properties: {
          version: {
            type: 'integer',
            description:
              'Optimistic concurrency token (`__v`). Send it back on PUT/PATCH; a mismatch returns 409 STALE_RESOURCE.',
            example: 0,
          },
        },
      },
    ],
  },
  CursorMeta: {
    type: 'object',
    properties: {
      limit: { type: 'integer', example: 12 },
      count: { type: 'integer', example: 12 },
      sort: { type: 'string', enum: ['newest', 'price_asc', 'price_desc'] },
      hasNextPage: { type: 'boolean' },
      nextCursor: {
        type: 'string',
        nullable: true,
        description: 'Opaque, HMAC-signed cursor. Pass back verbatim as `cursor`.',
      },
    },
  },
  OffsetMeta: {
    type: 'object',
    properties: {
      page: { type: 'integer', example: 1 },
      limit: { type: 'integer', example: 20 },
      total: { type: 'integer', example: 42 },
      totalPages: { type: 'integer', example: 3 },
      hasNextPage: { type: 'boolean' },
      hasPrevPage: { type: 'boolean' },
      sort: { type: 'string' },
      searchMode: { type: 'string', enum: ['regex', 'text'] },
    },
  },
  ProductWriteBody: {
    type: 'object',
    required: ['title', 'description', 'price', 'stock', 'brand', 'category'],
    properties: {
      title: { type: 'string', minLength: 2, maxLength: 160 },
      description: { type: 'string', minLength: 1, maxLength: 5000 },
      price: { type: 'number', minimum: 0, maximum: 1000000000 },
      stock: { type: 'integer', minimum: 0, maximum: 1000000 },
      brand: { type: 'string', example: '6511f0aaa1b2c3d4e5f60718' },
      category: { type: 'string', example: '6511f0aaa1b2c3d4e5f60719' },
      sku: {
        type: 'string',
        pattern: '^[A-Z0-9-]{3,32}$',
        description: 'Auto-generated when omitted.',
      },
      isActive: { type: 'boolean', default: true },
      version: {
        type: 'integer',
        description: 'Required on update requests only (optimistic concurrency token).',
      },
      image: {
        type: 'string',
        format: 'binary',
        description: 'Multipart file field (JPEG/PNG/WEBP, max 5MB).',
      },
    },
  },
  BrandWriteBody: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 60 },
      description: { type: 'string', maxLength: 500 },
    },
  },
  CategoryWriteBody: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 60 },
      description: { type: 'string', maxLength: 500 },
    },
  },
  LoginBody: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', example: 'Admin123!' },
    },
  },
  RegisterBody: {
    type: 'object',
    required: ['name', 'email', 'password', 'confirmPassword'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 80 },
      email: { type: 'string', format: 'email' },
      password: {
        type: 'string',
        description:
          'At least 10 characters with an uppercase letter, a lowercase letter, a number and a symbol.',
      },
      confirmPassword: { type: 'string' },
    },
  },
  ChangePasswordBody: {
    type: 'object',
    required: ['currentPassword', 'newPassword', 'confirmPassword'],
    properties: {
      currentPassword: { type: 'string' },
      newPassword: { type: 'string' },
      confirmPassword: { type: 'string' },
    },
  },
  StockUpdateBody: {
    type: 'object',
    description:
      'Provide exactly one of `delta` (atomic increment/decrement) or `stock` (absolute).',
    properties: {
      delta: { type: 'integer', example: -3 },
      stock: { type: 'integer', example: 42 },
    },
  },
  TaxonomyListQuery: {
    search: { type: 'string', maxLength: 60, description: 'Case-insensitive name search.' },
    sort: { type: 'string', enum: ['name', '-name', 'createdAt', '-createdAt'], default: 'name' },
  },
};

const { search: taxonomySearch, sort: taxonomySort } = schemas.TaxonomyListQuery;

const siteTag = { name: 'Storefront', description: 'Public, unauthenticated catalogue endpoints.' };
const authTag = { name: 'Authentication', description: 'Session, CSRF and credential management.' };
const adminTag = { name: 'Admin', description: 'Admin-only management endpoints (role: admin).' };
const taxonomyTag = { name: 'Taxonomy', description: 'Brands and categories.' };

// ---------------------------------------------------------------- paths
const paths = {
  [`${API_PREFIX}/health`]: {
    get: {
      tags: ['System'],
      summary: 'Liveness probe',
      description: 'Reports process uptime and database connectivity. Returns 503 when degraded.',
      security: [],
      responses: {
        200: {
          description: 'Service healthy',
          content: {
            'application/json': {
              schema: envelope({
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['ok', 'degraded'] },
                  uptimeSeconds: { type: 'integer' },
                  database: { type: 'string' },
                  environment: { type: 'string' },
                },
              }),
            },
          },
        },
        503: errorResponse('Service degraded (database unavailable)', 'SERVICE_DEGRADED'),
      },
    },
  },

  [`${API_PREFIX}/auth/csrf`]: {
    get: {
      tags: [authTag.name],
      summary: 'Issue a CSRF token',
      description:
        'Sets the readable `csrf_token` cookie and returns the same value. Call it once when the SPA boots, then echo the value in `X-CSRF-Token`.',
      security: [],
      responses: {
        200: {
          description: 'Token issued',
          content: {
            'application/json': {
              schema: envelope({
                type: 'object',
                properties: { csrfToken: { type: 'string' } },
              }),
            },
          },
        },
        429: errorResponse('Rate limit exceeded', 'RATE_LIMITED'),
      },
    },
  },

  [`${API_PREFIX}/auth/login`]: {
    post: {
      tags: [authTag.name],
      summary: 'Sign in',
      description:
        'Verifies credentials and sets the httpOnly `access_token` cookie plus a rotated CSRF token. Five consecutive failures lock the account for 15 minutes; per-IP rate limiting applies as well.',
      security: [],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginBody' } } },
      },
      responses: {
        200: {
          description: 'Signed in',
          content: {
            'application/json': {
              schema: envelope({
                type: 'object',
                properties: {
                  user: { $ref: '#/components/schemas/User' },
                  csrfToken: { type: 'string' },
                  expiresInMs: { type: 'integer' },
                },
              }),
            },
          },
        },
        401: errorResponse('Invalid email or password', 'INVALID_CREDENTIALS'),
        403: errorResponse('CSRF token missing or invalid', 'CSRF_TOKEN_MISSING'),
        429: {
          ...errorResponse('Rate limited or account locked', 'ACCOUNT_LOCKED'),
        },
      },
    },
  },

  [`${API_PREFIX}/auth/register`]: {
    post: {
      tags: [authTag.name],
      summary: 'Register a customer account',
      description:
        'Always creates a `customer`. The body is strict-validated, so a `role` field is rejected with 400 rather than ignored.',
      security: [],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterBody' } } },
      },
      responses: {
        201: {
          description: 'Account created and signed in',
          content: {
            'application/json': {
              schema: envelope({
                type: 'object',
                properties: {
                  user: { $ref: '#/components/schemas/User' },
                  csrfToken: { type: 'string' },
                  expiresInMs: { type: 'integer' },
                },
              }),
            },
          },
        },
        400: errorResponse('Password policy or confirmation mismatch', 'VALIDATION_ERROR'),
        409: errorResponse('Email already registered', 'EMAIL_IN_USE'),
        429: errorResponse('Rate limit exceeded', 'RATE_LIMITED'),
      },
    },
  },

  [`${API_PREFIX}/auth/logout`]: {
    post: {
      tags: [authTag.name],
      summary: 'Sign out',
      description: 'Clears both auth cookies. Idempotent.',
      security: [{ cookieAuth: [] }],
      parameters: [csrfHeader],
      responses: {
        200: { description: 'Signed out' },
        403: errorResponse('CSRF token missing or invalid', 'CSRF_TOKEN_MISSING'),
      },
    },
  },

  [`${API_PREFIX}/auth/me`]: {
    get: {
      tags: [authTag.name],
      summary: 'Current session',
      description:
        'Restores the session after a page refresh. The user is re-read from the database.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      responses: {
        200: {
          description: 'Current user',
          content: {
            'application/json': {
              schema: envelope({
                type: 'object',
                properties: { user: { $ref: '#/components/schemas/User' } },
              }),
            },
          },
        },
        401: errorResponse('Not authenticated or session revoked', 'SESSION_REVOKED'),
        429: errorResponse('Rate limit exceeded', 'RATE_LIMITED'),
      },
    },
  },

  [`${API_PREFIX}/auth/change-password`]: {
    post: {
      tags: [authTag.name],
      summary: 'Change password',
      description:
        'Requires the current password, applies the password policy, bumps `tokenVersion` (revoking every other session) and re-issues cookies.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ChangePasswordBody' } },
        },
      },
      responses: {
        200: {
          description: 'Password updated',
          content: {
            'application/json': {
              schema: envelope({
                type: 'object',
                properties: {
                  user: { $ref: '#/components/schemas/User' },
                  csrfToken: { type: 'string' },
                  expiresInMs: { type: 'integer' },
                },
              }),
            },
          },
        },
        400: errorResponse(
          'Current password incorrect or policy violation',
          'CURRENT_PASSWORD_INVALID',
        ),
        401: errorResponse('Authentication required', 'AUTH_REQUIRED'),
        403: errorResponse('CSRF token missing or invalid', 'CSRF_TOKEN_MISSING'),
      },
    },
  },

  [`${API_PREFIX}/brands`]: {
    get: {
      tags: [taxonomyTag.name],
      summary: 'List brands',
      security: [],
      parameters: query([
        { name: 'search', in: 'query', schema: taxonomySearch },
        { name: 'sort', in: 'query', schema: taxonomySort },
      ]),
      responses: {
        200: {
          description: 'Brands with product counts',
          content: {
            'application/json': {
              schema: envelope(
                { type: 'array', items: { $ref: '#/components/schemas/Brand' } },
                {
                  type: 'object',
                  properties: { total: { type: 'integer' } },
                },
              ),
            },
          },
        },
        ...standardErrors({ auth: false }),
      },
    },
    post: {
      tags: [taxonomyTag.name, adminTag.name],
      summary: 'Create a brand',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/BrandWriteBody' } },
        },
      },
      responses: {
        201: {
          description: 'Brand created',
          content: {
            'application/json': {
              schema: envelope({ $ref: '#/components/schemas/Brand' }),
            },
          },
        },
        409: errorResponse(
          'A brand with this name already exists (case-insensitive)',
          'BRAND_NAME_TAKEN',
        ),
        ...standardErrors({ admin: true }),
      },
    },
  },

  [`${API_PREFIX}/brands/{id}`]: {
    parameters: [idParam],
    get: {
      tags: [taxonomyTag.name],
      summary: 'Get a brand by id or slug',
      security: [],
      responses: {
        200: {
          description: 'Brand',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/Brand' }) },
          },
        },
        404: errorResponse('Brand not found', 'BRAND_NOT_FOUND'),
        ...standardErrors({ auth: false }),
      },
    },
    put: {
      tags: [taxonomyTag.name, adminTag.name],
      summary: 'Update a brand',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/BrandWriteBody' } },
        },
      },
      responses: {
        200: {
          description: 'Brand updated (slug regenerated on a real rename)',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/Brand' }) },
          },
        },
        404: errorResponse('Brand not found', 'BRAND_NOT_FOUND'),
        409: errorResponse('Name conflict', 'BRAND_NAME_TAKEN'),
        ...standardErrors({ admin: true }),
      },
    },
    delete: {
      tags: [taxonomyTag.name, adminTag.name],
      summary: 'Delete a brand',
      description: 'Blocked with 409 while any product references the brand.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      responses: {
        200: { description: 'Brand deleted' },
        404: errorResponse('Brand not found', 'BRAND_NOT_FOUND'),
        409: errorResponse('Brand is referenced by products', 'BRAND_IN_USE'),
        ...standardErrors({ admin: true }),
      },
    },
  },

  [`${API_PREFIX}/categories`]: {
    get: {
      tags: [taxonomyTag.name],
      summary: 'List categories',
      security: [],
      parameters: query([
        { name: 'search', in: 'query', schema: taxonomySearch },
        { name: 'sort', in: 'query', schema: taxonomySort },
      ]),
      responses: {
        200: {
          description: 'Categories with product counts',
          content: {
            'application/json': {
              schema: envelope(
                { type: 'array', items: { $ref: '#/components/schemas/Category' } },
                {
                  type: 'object',
                  properties: { total: { type: 'integer' } },
                },
              ),
            },
          },
        },
        ...standardErrors({ auth: false }),
      },
    },
    post: {
      tags: [taxonomyTag.name, adminTag.name],
      summary: 'Create a category',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CategoryWriteBody' } },
        },
      },
      responses: {
        201: {
          description: 'Category created',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/Category' }) },
          },
        },
        409: errorResponse('A category with this name already exists', 'CATEGORY_NAME_TAKEN'),
        ...standardErrors({ admin: true }),
      },
    },
  },

  [`${API_PREFIX}/categories/{id}`]: {
    parameters: [idParam],
    get: {
      tags: [taxonomyTag.name],
      summary: 'Get a category by id or slug',
      security: [],
      responses: {
        200: {
          description: 'Category',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/Category' }) },
          },
        },
        404: errorResponse('Category not found', 'CATEGORY_NOT_FOUND'),
        ...standardErrors({ auth: false }),
      },
    },
    put: {
      tags: [taxonomyTag.name, adminTag.name],
      summary: 'Update a category',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/CategoryWriteBody' } },
        },
      },
      responses: {
        200: {
          description: 'Category updated',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/Category' }) },
          },
        },
        404: errorResponse('Category not found', 'CATEGORY_NOT_FOUND'),
        409: errorResponse('Name conflict', 'CATEGORY_NAME_TAKEN'),
        ...standardErrors({ admin: true }),
      },
    },
    delete: {
      tags: [taxonomyTag.name, adminTag.name],
      summary: 'Delete a category',
      description: 'Blocked with 409 while any product references the category.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      responses: {
        200: { description: 'Category deleted' },
        404: errorResponse('Category not found', 'CATEGORY_NOT_FOUND'),
        409: errorResponse('Category is referenced by products', 'CATEGORY_IN_USE'),
        ...standardErrors({ admin: true }),
      },
    },
  },

  [`${API_PREFIX}/products`]: {
    get: {
      tags: [siteTag.name],
      summary: 'Storefront product list (cursor pagination)',
      description: [
        'Only active products are returned.',
        '',
        '**Pagination contract**',
        '- `newest` (default): single-field cursor on `_id`, `{ _id: { $lt: cursor } }`, sorted `_id: -1`.',
        '- `price_asc`: compound cursor `{ price: 1, _id: 1 }` with `$or: [{ price: { $gt: p } }, { price: p, _id: { $gt: id } }]`.',
        '- `price_desc`: compound cursor `{ price: -1, _id: -1 }` with `$or: [{ price: { $lt: p } }, { price: p, _id: { $lt: id } }]`.',
        '',
        'Cursors are HMAC-signed and carry the sort plus a fingerprint of the filters. Reusing a cursor with a',
        'different sort returns 400 `CURSOR_SORT_MISMATCH`; changing filters returns 400 `CURSOR_FILTER_MISMATCH` —',
        'restart pagination in both cases. `hasNextPage` is exact (limit+1 probe), so no count query is performed.',
      ].join('\n'),
      security: [],
      parameters: query([
        {
          name: 'cursor',
          in: 'query',
          schema: { type: 'string', maxLength: 512 },
          description: 'Opaque cursor from the previous page. Omit for the first page.',
        },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 48, default: 12 },
        },
        {
          name: 'search',
          in: 'query',
          schema: { type: 'string', maxLength: 80 },
          description: 'Case-insensitive substring match on title/SKU.',
        },
        { name: 'minPrice', in: 'query', schema: { type: 'number', minimum: 0 } },
        { name: 'maxPrice', in: 'query', schema: { type: 'number', minimum: 0 } },
        { name: 'brand', in: 'query', schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } },
        { name: 'category', in: 'query', schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } },
        {
          name: 'sort',
          in: 'query',
          schema: {
            type: 'string',
            enum: ['newest', 'price_asc', 'price_desc'],
            default: 'newest',
          },
        },
      ]),
      responses: {
        200: {
          description: 'A page of products',
          content: {
            'application/json': {
              schema: envelope(
                { type: 'array', items: { $ref: '#/components/schemas/Product' } },
                {
                  $ref: '#/components/schemas/CursorMeta',
                },
              ),
            },
          },
        },
        400: errorResponse(
          'Invalid filters or an invalid/sort-incompatible cursor',
          'CURSOR_SORT_MISMATCH',
        ),
        429: errorResponse('Rate limit exceeded', 'RATE_LIMITED'),
      },
    },
  },

  [`${API_PREFIX}/products/{id}`]: {
    parameters: [idParam],
    get: {
      tags: [siteTag.name],
      summary: 'Product detail',
      description:
        'Accepts an ObjectId or a slug. Inactive products return 404 for public callers.',
      security: [],

      responses: {
        200: {
          description: 'Product',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/Product' }) },
          },
        },
        404: errorResponse('Product not found or not active', 'PRODUCT_NOT_FOUND'),
        429: errorResponse('Rate limit exceeded', 'RATE_LIMITED'),
      },
    },
  },

  [`${API_PREFIX}/admin/products`]: {
    get: {
      tags: [adminTag.name],
      summary: 'Admin product list (offset pagination)',
      description:
        'Page-based pagination with an exact `total` from a parallel `countDocuments()`. Includes inactive products. `searchMode=text` uses the MongoDB text index (weighted relevance), `regex` (default) does substring matching for mid-word lookups.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: query([
        { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
        { name: 'search', in: 'query', schema: { type: 'string', maxLength: 80 } },
        {
          name: 'searchMode',
          in: 'query',
          schema: { type: 'string', enum: ['regex', 'text'], default: 'regex' },
        },
        { name: 'brand', in: 'query', schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } },
        { name: 'category', in: 'query', schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } },
        { name: 'isActive', in: 'query', schema: { type: 'boolean' } },
        {
          name: 'sort',
          in: 'query',
          schema: {
            type: 'string',
            enum: ['-createdAt', 'createdAt', 'price', '-price', 'title', '-title'],
            default: '-createdAt',
          },
        },
      ]),
      responses: {
        200: {
          description: 'A page of products',
          content: {
            'application/json': {
              schema: envelope(
                { type: 'array', items: { $ref: '#/components/schemas/AdminProduct' } },
                { $ref: '#/components/schemas/OffsetMeta' },
              ),
            },
          },
        },
        ...standardErrors({ admin: true }),
      },
    },
    post: {
      tags: [adminTag.name],
      summary: 'Create a product',
      description:
        'Accepts `application/json` or `multipart/form-data` with an `image` file. Slugs and SKUs are generated server-side when omitted, with collision retry. The image is validated by magic bytes, dimension/pixel caps and re-encoded to JPEG/WEBP at max 1200x1200 with a 300x300 thumbnail and all metadata stripped.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ProductWriteBody' } },
          'multipart/form-data': { schema: { $ref: '#/components/schemas/ProductWriteBody' } },
        },
      },
      responses: {
        201: {
          description: 'Product created',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/AdminProduct' }) },
          },
        },
        400: errorResponse('Validation failed or unknown brand/category', 'BRAND_NOT_FOUND'),
        409: errorResponse('Duplicate SKU/slug', 'DUPLICATE_KEY'),
        413: errorResponse('Image exceeds the size limit', 'FILE_TOO_LARGE'),
        422: errorResponse('Unsupported or corrupt image', 'UNSUPPORTED_FILE_TYPE'),
        ...standardErrors({ admin: true }),
      },
    },
  },

  [`${API_PREFIX}/admin/products/maintenance/sweep-orphans`]: {
    post: {
      tags: [adminTag.name],
      summary: 'Sweep orphaned image files',
      description:
        'Deletes files in the upload directory that no product references — recovery for a crash between writing an image and saving the record.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      responses: {
        200: {
          description: 'Sweep summary',
          content: {
            'application/json': {
              schema: envelope({
                type: 'object',
                properties: { scanned: { type: 'integer' }, removed: { type: 'integer' } },
              }),
            },
          },
        },
        ...standardErrors({ admin: true }),
      },
    },
  },

  [`${API_PREFIX}/admin/products/{id}`]: {
    parameters: [idParam],
    get: {
      tags: [adminTag.name],
      summary: 'Admin product detail (includes inactive products and `version`)',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      responses: {
        200: {
          description: 'Product',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/AdminProduct' }) },
          },
        },
        404: errorResponse('Product not found', 'PRODUCT_NOT_FOUND'),
        ...standardErrors({ admin: true }),
      },
    },
    put: {
      tags: [adminTag.name],
      summary: 'Replace a product (requires `version`)',
      description:
        'Full replacement of the editable fields. Send the `version` you last read; a concurrent edit yields 409 `STALE_RESOURCE` (Mongoose `VersionError`). Optionally accepts a new `image` file; the previous files are deleted after the write succeeds.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ProductWriteBody' } },
          'multipart/form-data': { schema: { $ref: '#/components/schemas/ProductWriteBody' } },
        },
      },
      responses: {
        200: {
          description: 'Product replaced',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/AdminProduct' }) },
          },
        },
        404: errorResponse('Product not found', 'PRODUCT_NOT_FOUND'),
        409: errorResponse('Stale version (concurrent edit)', 'STALE_RESOURCE'),
        ...standardErrors({ admin: true }),
      },
    },
    patch: {
      tags: [adminTag.name],
      summary: 'Partially update a product (requires `version`)',
      description:
        'Any subset of editable fields, or only an image. Same optimistic concurrency contract as PUT.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ProductWriteBody' } },
          'multipart/form-data': { schema: { $ref: '#/components/schemas/ProductWriteBody' } },
        },
      },
      responses: {
        200: {
          description: 'Product updated',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/AdminProduct' }) },
          },
        },
        404: errorResponse('Product not found', 'PRODUCT_NOT_FOUND'),
        409: errorResponse('Stale version (concurrent edit)', 'STALE_RESOURCE'),
        ...standardErrors({ admin: true }),
      },
    },
    delete: {
      tags: [adminTag.name],
      summary: 'Delete a product',
      description: 'Removes the record and its image/thumbnail files.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      responses: {
        200: { description: 'Product deleted' },
        404: errorResponse('Product not found', 'PRODUCT_NOT_FOUND'),
        ...standardErrors({ admin: true }),
      },
    },
  },

  [`${API_PREFIX}/admin/products/{id}/stock`]: {
    parameters: [idParam],
    patch: {
      tags: [adminTag.name],
      summary: 'Atomic stock adjustment',
      description:
        'Single-document atomic update: `delta` uses `$inc` guarded by `stock: { $gte: -delta }`, so parallel decrements can never oversell. `stock` sets an absolute value. Both bump `version`.',
      security: [{ cookieAuth: [] }, { bearerAuth: [] }],
      parameters: [csrfHeader],
      requestBody: {
        required: true,
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/StockUpdateBody' } },
        },
      },
      responses: {
        200: {
          description: 'Stock updated',
          content: {
            'application/json': { schema: envelope({ $ref: '#/components/schemas/AdminProduct' }) },
          },
        },
        404: errorResponse('Product not found', 'PRODUCT_NOT_FOUND'),
        409: errorResponse('Insufficient stock for the requested decrement', 'INSUFFICIENT_STOCK'),
        ...standardErrors({ admin: true }),
      },
    },
  },
};

export const openApiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Product Catalogue API',
    version: '1.0.0',
    description: [
      'REST API for the product catalogue platform (public storefront + admin dashboard).',
      '',
      '**Authentication** — the browser SPA authenticates with an httpOnly `access_token` cookie (JWT, HS256).',
      'Every unsafe method (POST/PUT/PATCH/DELETE) additionally requires the `X-CSRF-Token` header matching the',
      'readable `csrf_token` cookie (signed double-submit). Server-to-server clients may instead send',
      '`Authorization: Bearer <jwt>` and are then exempt from CSRF.',
      '',
      '**Response envelope** — every response is `{ success, message, data, meta?, requestId }`; errors add',
      '`error: { code, details }`. `requestId` matches the `X-Request-Id` response header and the server log line.',
      '',
      '**Pagination** — two strategies are exposed deliberately:',
      '- storefront `/products` uses **cursor** pagination (stable under concurrent inserts, O(limit) cost);',
      '- admin `/admin/products` uses **offset** pagination with exact totals for numbered pages.',
    ].join('\n'),
    license: { name: 'MIT' },
  },
  servers: [
    { url: env.FRONTEND_URL.replace(/:\d+$/, ':5000'), description: 'Local development API' },
    { url: 'https://api.catalogue.example.com', description: 'Production (placeholder)' },
  ],
  tags: [
    { name: 'System', description: 'Health and diagnostics.' },
    authTag,
    siteTag,
    taxonomyTag,
    adminTag,
  ],
  paths,
  components: {
    schemas,
    securitySchemes: {
      cookieAuth: {
        type: 'apiKey',
        in: 'cookie',
        name: 'access_token',
        description: 'httpOnly JWT cookie issued by `POST /auth/login`. Requires the CSRF header.',
      },
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Stateless clients only. CSRF does not apply to Bearer-authenticated requests.',
      },
    },
  },
};

/**
 * Mounts Swagger UI and the raw spec.
 *
 * The API's global CSP would block Swagger UI's inline scripts, so a permissive
 * CSP is scoped to the docs routes only (nothing else on the origin is affected).
 *
 * @param {import('express').Express} app
 */
export function mountApiDocs(app) {
  const docsPath = `${API_PREFIX}/docs`;

  app.get(`${API_PREFIX}/docs.json`, (_req, res) => res.json(openApiSpec));

  app.use(
    docsPath,
    (req, res, next) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
      );
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: 'Product Catalogue API',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );

  return app;
}

export default mountApiDocs;
