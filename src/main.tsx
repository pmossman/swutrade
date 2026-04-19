import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './contexts/AuthContext.tsx'
import { PriceDataProvider } from './contexts/PriceDataContext.tsx'
import { CardIndexProvider } from './contexts/CardIndexContext.tsx'
import { DrawerProvider } from './contexts/DrawerContext.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <PriceDataProvider>
        <CardIndexProvider>
          <DrawerProvider>
            <App />
          </DrawerProvider>
        </CardIndexProvider>
      </PriceDataProvider>
    </AuthProvider>
  </StrictMode>,
)
