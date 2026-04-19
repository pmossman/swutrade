import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './contexts/AuthContext.tsx'
import { PriceDataProvider } from './contexts/PriceDataContext.tsx'
import { CardIndexProvider } from './contexts/CardIndexContext.tsx'
import { DrawerProvider } from './contexts/DrawerContext.tsx'
import { PricingProvider } from './contexts/PricingContext.tsx'
import { ErrorBoundary } from './components/ui/ErrorBoundary.tsx'

// Root-level error boundary sits OUTSIDE the providers so a throw in
// provider initialization itself still surfaces the fallback UI instead
// of a blank page. Per-view boundaries (scoped fallback) can nest
// inside later when individual views want graceful-degradation instead
// of a full-page recovery prompt.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary label="root">
      <AuthProvider>
        <PriceDataProvider>
          <CardIndexProvider>
            <DrawerProvider>
              <PricingProvider>
                <App />
              </PricingProvider>
            </DrawerProvider>
          </CardIndexProvider>
        </PriceDataProvider>
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>,
)
