import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAppDispatch, useAppSelector } from '../app/hooks.js';
import { apiSlice, useChangePasswordMutation } from '../api/apiSlice.js';
import {
  passwordRotationCompleted,
  selectCurrentUser,
  selectMustChangePassword,
} from '../features/auth/authSlice.js';
import { errorMessage, fieldErrorsFromApi } from '../utils/format.js';
import { LIMITS } from '../utils/constants.js';
import { toastAdded } from '../features/ui/uiSlice.js';
import Field from '../components/Field.jsx';
import { useDocumentTitle } from '../hooks/useDocumentTitle.js';

const PASSWORD_RULE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).+$/;

/** Mirrors the backend password policy so users get instant, precise feedback. */
export function validatePasswordChange(values) {
  const errors = {};
  if (!values.currentPassword) errors.currentPassword = 'Enter your current password';

  const next = values.newPassword ?? '';
  if (next.length < LIMITS.PASSWORD_MIN) {
    errors.newPassword = `Password must be at least ${LIMITS.PASSWORD_MIN} characters`;
  } else if (next.length > LIMITS.PASSWORD_MAX) {
    errors.newPassword = `Password must be at most ${LIMITS.PASSWORD_MAX} characters`;
  } else if (!PASSWORD_RULE.test(next)) {
    errors.newPassword = 'Include an uppercase letter, a lowercase letter, a number and a symbol';
  } else if (next === values.currentPassword) {
    errors.newPassword = 'New password must be different from the current password';
  }

  if (values.confirmPassword !== next) errors.confirmPassword = 'Passwords do not match';
  return errors;
}

export function ChangePasswordPage() {
  useDocumentTitle('Change password');
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const user = useAppSelector(selectCurrentUser);
  const forced = useAppSelector(selectMustChangePassword);
  const [changePassword, { isLoading }] = useChangePasswordMutation();

  const [values, setValues] = useState({
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  const handleChange = (field) => (event) => {
    setValues((current) => ({ ...current, [field]: event.target.value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setFormError(null);
    const validation = validatePasswordChange(values);
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;

    try {
      await changePassword(values).unwrap();
      // The server revoked the flag; mirror that locally (so the route guard lets
      // the user through immediately) and re-sync `/auth/me` in the background.
      dispatch(passwordRotationCompleted());
      dispatch(apiSlice.util.invalidateTags(['Auth']));
      dispatch(
        toastAdded({
          message: 'Password updated. Other sessions were signed out.',
          type: 'success',
        }),
      );
      navigate('/admin', { replace: true });
    } catch (error) {
      const fieldErrors = fieldErrorsFromApi(error);
      if (Object.keys(fieldErrors).length > 0) setErrors(fieldErrors);
      setFormError(errorMessage(error, 'Could not update your password.'));
    }
  };

  return (
    <div className="container container--narrow">
      <div className="card auth-card">
        <h1>Set a new password</h1>
        <p className="auth-card__subtitle">
          {forced
            ? 'Your account was created with a shared development password. Choose a private one to continue.'
            : `Signed in as ${user?.email}. Changing your password signs out all other sessions.`}
        </p>

        {formError ? (
          <div className="alert alert--error" role="alert" style={{ marginBottom: 16 }}>
            {formError}
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <Field label="Current password" error={errors.currentPassword} required>
            {(props) => (
              <input
                {...props}
                className="input"
                type="password"
                autoComplete="current-password"
                value={values.currentPassword}
                onChange={handleChange('currentPassword')}
                aria-invalid={errors.currentPassword ? 'true' : undefined}
              />
            )}
          </Field>
          <Field
            label="New password"
            error={errors.newPassword}
            hint="At least 10 characters with upper case, lower case, a number and a symbol."
            required
          >
            {(props) => (
              <input
                {...props}
                className="input"
                type="password"
                autoComplete="new-password"
                value={values.newPassword}
                onChange={handleChange('newPassword')}
                aria-invalid={errors.newPassword ? 'true' : undefined}
              />
            )}
          </Field>
          <Field label="Confirm new password" error={errors.confirmPassword} required>
            {(props) => (
              <input
                {...props}
                className="input"
                type="password"
                autoComplete="new-password"
                value={values.confirmPassword}
                onChange={handleChange('confirmPassword')}
                aria-invalid={errors.confirmPassword ? 'true' : undefined}
              />
            )}
          </Field>

          <button type="submit" className="btn btn--primary btn--block" disabled={isLoading}>
            {isLoading ? <span className="btn__spinner" aria-hidden="true" /> : null}
            {isLoading ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default ChangePasswordPage;
