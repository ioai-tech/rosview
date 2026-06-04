import { createRoot } from 'react-dom/client';
import './standalone.css';
import '../index.css';
import App from './App.tsx';

createRoot(document.getElementById('root')!).render(
  <App />
)
