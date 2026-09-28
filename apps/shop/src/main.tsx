import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './styles.css';

/**
 * Mounted at `/shop/`, so the router is given the basename rather than every
 * route in the app repeating the prefix.
 */
const container = document.getElementById('root');
if (container === null) {
  throw new Error('index.html is missing its #root element');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter basename="/shop">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
