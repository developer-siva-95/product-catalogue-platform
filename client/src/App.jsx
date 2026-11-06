import { RouterProvider } from 'react-router/dom';
import { Outlet, createBrowserRouter } from 'react-router';
import StorefrontLayout from './components/StorefrontLayout.jsx';
import AdminLayout from './components/AdminLayout.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import SessionBootstrap from './components/SessionBootstrap.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import StorefrontPage from './pages/StorefrontPage.jsx';
import ProductDetailPage from './pages/ProductDetailPage.jsx';
import LoginPage from './pages/LoginPage.jsx';
import ChangePasswordPage from './pages/ChangePasswordPage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';
import AdminDashboardPage from './pages/admin/AdminDashboardPage.jsx';
import AdminProductsPage from './pages/admin/AdminProductsPage.jsx';
import ProductFormPage from './pages/admin/ProductFormPage.jsx';
import BrandsPage from './pages/admin/BrandsPage.jsx';
import CategoriesPage from './pages/admin/CategoriesPage.jsx';

/**
 * Root shell. `SessionBootstrap` runs once above every route so the session is
 * restored (or definitively rejected) before any guard makes a decision.
 */
function AppShell() {
  return (
    <>
      <SessionBootstrap />
      <Outlet />
    </>
  );
}

export const routeConfig = [
  {
    element: <AppShell />,
    children: [
      {
        path: '/',
        element: <StorefrontLayout />,
        children: [
          { index: true, element: <StorefrontPage /> },
          { path: 'product/:id', element: <ProductDetailPage /> },
        ],
      },
      { path: '/login', element: <LoginPage /> },
      {
        // Authenticated, but deliberately allows flagged accounts so they can
        // actually reach the password-change screen.
        element: <ProtectedRoute requireAdmin={false} allowFlaggedPassword />,
        children: [{ path: '/change-password', element: <ChangePasswordPage /> }],
      },
      {
        element: <ProtectedRoute requireAdmin />,
        children: [
          {
            path: '/admin',
            element: <AdminLayout />,
            children: [
              { index: true, element: <AdminDashboardPage /> },
              { path: 'products', element: <AdminProductsPage /> },
              { path: 'products/new', element: <ProductFormPage /> },
              { path: 'products/:id', element: <ProductFormPage /> },
              { path: 'brands', element: <BrandsPage /> },
              { path: 'categories', element: <CategoriesPage /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];

export const router = createBrowserRouter(routeConfig);

export function App() {
  return (
    <ErrorBoundary>
      <RouterProvider router={router} />
    </ErrorBoundary>
  );
}

export default App;
