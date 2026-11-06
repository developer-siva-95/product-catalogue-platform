import { useDispatch, useSelector } from 'react-redux';

/** Thin, app-wide typed helpers (JS project, so these are convention only). */
export const useAppDispatch = () => useDispatch();
export const useAppSelector = useSelector;
