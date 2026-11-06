import { Link, NavLink, Outlet } from 'react-router';
import { useAppSelector } from '../app/hooks.js';
import { selectIsAdmin, selectIsAuthenticated } from '../features/auth/authSlice.js';

/** Public site chrome: sticky header, skip link, footer, routed content. */
export function StorefrontLayout() {
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const isAdmin = useAppSelector(selectIsAdmin);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="site-header">
        <div className="container site-header__inner">
          <Link to="/" className="brand-mark">
            <span className="brand-mark__dot" aria-hidden="true">
              ◆
            </span>
            Aurora Catalogue
          </Link>
          <nav className="site-header__nav" aria-label="Main">
            <NavLink to="/" className="btn btn--ghost btn--sm" end>
              Shop
            </NavLink>
            {isAuthenticated && isAdmin ? (
              <Link to="/admin" className="btn btn--secondary btn--sm">
                Admin dashboard
              </Link>
            ) : (
              <Link to="/login" className="btn btn--primary btn--sm">
                Admin sign in
              </Link>
            )}
          </nav>
        </div>
      </header>

      <main id="main-content">
        <Outlet />
      </main>

      <footer className="site-footer">
        <div className="container row">
          <span>© {new Date().getFullYear()} Aurora Catalogue. Demo storefront.</span>
          <span className="push-right">Built with Express, MongoDB, React &amp; RTK Query.</span>
        </div>
      </footer>
    </div>
  );
}

export default StorefrontLayout;
