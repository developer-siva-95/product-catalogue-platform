import { Link, NavLink, Outlet, useNavigate } from 'react-router';
import { useAppDispatch, useAppSelector } from '../app/hooks.js';
import { selectCurrentUser, sessionCleared } from '../features/auth/authSlice.js';
import { useLogoutMutation } from '../api/apiSlice.js';
import { initialsOf } from '../utils/format.js';
import { toastAdded } from '../features/ui/uiSlice.js';

const NAV_ITEMS = [
  { to: '/admin', label: 'Overview', icon: '▦', end: true },
  { to: '/admin/products', label: 'Products', icon: '☰' },
  { to: '/admin/brands', label: 'Brands', icon: '◈' },
  { to: '/admin/categories', label: 'Categories', icon: '❏' },
];

/** Admin chrome: persistent sidebar (collapses above the content on mobile). */
export function AdminLayout() {
  const user = useAppSelector(selectCurrentUser);
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const [logout, { isLoading }] = useLogoutMutation();

  const handleLogout = async () => {
    try {
      await logout().unwrap();
    } catch {
      // Logout is idempotent server-side; clear locally regardless.
    }
    dispatch(sessionCleared());
    dispatch(toastAdded({ message: 'Signed out', type: 'info' }));
    navigate('/login', { replace: true });
  };

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Link to="/admin" className="admin-sidebar__brand">
          <span className="brand-mark__dot" aria-hidden="true">
            ◆
          </span>
          Aurora Admin
        </Link>

        <nav className="admin-nav" aria-label="Admin sections">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="admin-nav__link">
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div style={{ marginTop: 'auto' }}>
          <Link to="/" className="admin-nav__link">
            <span aria-hidden="true">↗</span>
            View storefront
          </Link>
        </div>
      </aside>

      <div className="admin-main">
        <div className="admin-topbar">
          <div>
            <h1 style={{ fontSize: '1.375rem' }}>Catalogue management</h1>
            <p className="text-muted" style={{ fontSize: '0.875rem' }}>
              Products, brands and categories
            </p>
          </div>
          <div className="admin-user">
            <span className="admin-user__avatar" aria-hidden="true">
              {initialsOf(user?.name ?? 'Admin')}
            </span>
            <span>
              <strong style={{ display: 'block', color: 'var(--color-text)' }}>{user?.name}</strong>
              {user?.email}
            </span>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={handleLogout}
              disabled={isLoading}
            >
              {isLoading ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        </div>

        <Outlet />
      </div>
    </div>
  );
}

export default AdminLayout;
