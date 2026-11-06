import { Navigate, Outlet, useLocation } from 'react-router';
import { useAppSelector } from '../app/hooks.js';
import {
  selectAuthInitialized,
  selectIsAdmin,
  selectIsAuthenticated,
  selectMustChangePassword,
} from '../features/auth/authSlice.js';
import { LoadingBlock } from './Spinner.jsx';
import EmptyState from './EmptyState.jsx';

/**
 * Route guard used by the admin section.
 *
 * - waits for the initial `/auth/me` probe so a hard refresh does not flash the
 *   login screen (session restoration);
 * - redirects unauthenticated users to /login, remembering where they were going;
 * - enforces `role === 'admin'`;
 * - forces the password change flow for flagged accounts (seeded admin).
 */
export function ProtectedRoute({ requireAdmin = true, allowFlaggedPassword = false }) {
  const location = useLocation();
  const initialized = useAppSelector(selectAuthInitialized);
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const isAdmin = useAppSelector(selectIsAdmin);
  const mustChangePassword = useAppSelector(selectMustChangePassword);

  if (!initialized) return <LoadingBlock label="Restoring your session…" />;

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  if (requireAdmin && !isAdmin) {
    return (
      <div className="container page">
        <EmptyState
          icon="⛔"
          title="Administrator access required"
          description="This account does not have permission to open the admin dashboard."
          action={
            <a className="btn btn--secondary" href="/">
              Back to storefront
            </a>
          }
        />
      </div>
    );
  }

  if (mustChangePassword && !allowFlaggedPassword) {
    return <Navigate to="/change-password" replace />;
  }

  return <Outlet />;
}

export default ProtectedRoute;
