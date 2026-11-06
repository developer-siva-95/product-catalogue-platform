import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { App } from './App.jsx';
import { store } from './app/store.js';
import Toaster from './components/Toaster.jsx';
import './styles/global.css';
import './styles/components.css';

/**
 * Application entrypoint.
 * StrictMode is intentional: it surfaces unsafe effects (double-invoked effects,
 * missing cleanups) during development, which keeps the data-fetching effects in
 * the storefront and the auth bootstrap honest.
 */
const container = document.getElementById('root');
if (!container) throw new Error('Root element #root not found');

createRoot(container).render(
  <StrictMode>
    <Provider store={store}>
      <App />
      <Toaster />
    </Provider>
  </StrictMode>,
);
