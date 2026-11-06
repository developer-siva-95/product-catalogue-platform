import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router';
import { useAppDispatch, useAppSelector } from '../app/hooks.js';
import { useLoginMutation } from '../api/apiSlice.js';
import {
  selectCurrentUser,
  selectIsAuthenticated,
  sessionEstablished,
} from '../features/auth/authSlice.js';
import { errorMessage, fieldErrorsFromApi } from '../utils/format.js';
import { toastAdded } from '../features/ui/uiSlice.js';
import Field from '../components/Field.jsx';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';

/** Admin sign-in. Uses the httpOnly cookie session (no tokens in JS storage). */
export function LoginPage() {
  useDocumentTitle('Sign in');
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const location = useLocation();
  const isAuthenticated = useAppSelector(selectIsAuthenticated);
  const currentUser = useAppSelector(selectCurrentUser);
  const [login, { isLoading }] = useLoginMutation();

  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  /**
   * Single source of truth for the post-sign-in destination.
   *
   * An account that must rotate its password is always sent to the rotation
   * screen — choosing the target from the authenticated session (rather than
   * only from the mutation result) keeps the imperative `navigate()` after
   * login and this render-time redirect from disagreeing: with React 19 the
   * `sessionEstablished` dispatch can re-render synchronously, and the older
   * "redirect from location.state only" version then bounced the user to
   * /admin, skipping the mandatory rotation step.
   */
  const redirectTo =
    currentUser?.mustChangePassword === true
      ? '/change-password'
      : (location.state?.from ?? '/admin');

  if (isAuthenticated) return <Navigate to={redirectTo} replace />;

  const handleChange = (field) => (event) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const validate = () => {
    const nextErrors = {};
    if (!values.email.trim()) nextErrors.email = 'Email is required';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email.trim())) {
      nextErrors.email = 'Enter a valid email address';
    }
    if (!values.password) nextErrors.password = 'Password is required';
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError(null);
    if (!validate()) return;

    try {
      const result = await login({
        email: values.email.trim().toLowerCase(),
        password: values.password,
      }).unwrap();

      dispatch(sessionEstablished(result.data.user));
      dispatch(toastAdded({ message: `Welcome back, ${result.data.user.name}`, type: 'success' }));

      navigate(result.data.user.mustChangePassword ? '/change-password' : redirectTo, {
        replace: true,
      });
    } catch (error) {
      const fieldErrors = fieldErrorsFromApi(error);
      if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
      setFormError(errorMessage(error, 'Unable to sign in. Please try again.'));
    }
  };

  return (
    <div className="container container--narrow">
      <div className="card auth-card">
        <h1>Sign in</h1>
        <p className="auth-card__subtitle">Administrator access to the catalogue dashboard.</p>

        {formError ? (
          <div className="alert alert--error" role="alert" style={{ marginBottom: 16 }}>
            {formError}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <Field label="Email" error={errors.email} required>
            {(props) => (
              <input
                {...props}
                className="input"
                type="email"
                name="email"
                autoComplete="username"
                value={values.email}
                onChange={handleChange('email')}
                placeholder="admin@catalogue.com"
                aria-invalid={errors.email ? 'true' : undefined}
                aria-describedby={props.describedBy || undefined}
              />
            )}
          </Field>

          <Field label="Password" error={errors.password} required>
            {(props) => (
              <input
                {...props}
                className="input"
                type="password"
                name="password"
                autoComplete="current-password"
                value={values.password}
                onChange={handleChange('password')}
                aria-invalid={errors.password ? 'true' : undefined}
                aria-describedby={props.describedBy || undefined}
              />
            )}
          </Field>

          <button type="submit" className="btn btn--primary btn--block" disabled={isLoading}>
            {isLoading ? <span className="btn__spinner" aria-hidden="true" /> : null}
            {isLoading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <p className="auth-card__footer">
          <Link to="/">← Back to the storefront</Link>
        </p>

        <div className="alert alert--info" style={{ marginTop: 20, fontSize: 13 }}>
          <span aria-hidden="true">ⓘ</span>
          <span>
            <strong>Local development seed:</strong> admin@catalogue.com / Admin123! — you will be
            asked to set a new password on first sign-in.
          </span>
        </div>
      </div>
    </div>
  );
}

export default LoginPage;
