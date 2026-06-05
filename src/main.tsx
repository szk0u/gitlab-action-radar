import { render } from 'preact';
import { StrictMode } from 'preact/compat';
import { App } from './App';
import './styles.css';

render(
  <StrictMode>
    <App />
  </StrictMode>,
  document.getElementById('root')!,
);
