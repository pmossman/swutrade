import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { createQueryClient } from './lib/queryClient';
import './styles/globals.css';

const queryClient = createQueryClient();

const root = document.getElementById('root');
if (!root) {
  throw new Error('#root not found in index.html');
}

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
