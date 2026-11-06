import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useAppDispatch, useAppSelector } from '../app/hooks.js';
import { useMeQuery } from '../api/apiSlice.js';
import {
  selectAuthInitialized,
  selectMustChangePassword,
  sessionCleared,
  sessionEstablished,
  sessionInitialized,
} from '../features/auth/authSlice.js';

/**
 * Restores the session exactly once on boot (the httpOnly cookie is the source of
 * truth, so the SPA must ask the server who it is). Runs at the app root so every
 * route — including deep links — sees a settled auth state.
 */
export function SessionBootstrap() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const initialized = useAppSelector(selectAuthInitialized);
  const mustChangePassword = useAppSelector(selectMustChangePassword);

  const { data, error, isSuccess, isError, isLoading } = useMeQuery(undefined, {
    refetchOnMountOrArgChange: true,
  });

  useEffect(() => {
    if (isSuccess) dispatch(sessionEstablished(data.data.user));
    else if (isError) dispatch(sessionCleared());
    else if (!isLoading) dispatch(sessionInitialized());
  }, [dispatch, isSuccess, isError, isLoading, data, error]);

  // Force the rotation flow for a flagged account on first render after login.
  useEffect(() => {
    if (initialized && mustChangePassword) {
      navigate('/change-password', { replace: true });
    }
  }, [initialized, mustChangePassword, navigate]);

  return null;
}

export default SessionBootstrap;
