import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router-dom'
import { MainLayout } from '@/components/layout/MainLayout'
import { TrayView } from '@/components/Tray/TrayView'
import { Toaster } from '@/components/ui/toaster'
import { Skeleton } from '@/components/ui/skeleton'

const Dashboard = lazy(() => import('@/pages/Dashboard').then(m => ({ default: m.Dashboard })))
const Providers = lazy(() => import('@/pages/Providers').then(m => ({ default: m.Providers })))
const ProxySettings = lazy(() => import('@/pages/ProxySettings').then(m => ({ default: m.ProxySettings })))
const Models = lazy(() => import('@/pages/Models').then(m => ({ default: m.Models })))
const ApiKeys = lazy(() => import('@/pages/ApiKeys'))
const Logs = lazy(() => import('@/pages/Logs'))
const Settings = lazy(() => import('@/pages/Settings').then(m => ({ default: m.Settings })))
const About = lazy(() => import('@/pages/About').then(m => ({ default: m.About })))
const SessionManagement = lazy(() => import('@/pages/SessionManagement').then(m => ({ default: m.SessionManagement })))

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="space-y-4 w-full max-w-md">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-32 w-full" />
      </div>
    </div>
  )
}

function App() {
  return (
    <>
      <Routes>
        <Route path="/tray" element={<TrayView />} />
        <Route element={<MainLayout />}>
          <Route path="/" element={<Suspense fallback={<PageLoader />}><Dashboard /></Suspense>} />
          <Route path="/providers" element={<Suspense fallback={<PageLoader />}><Providers /></Suspense>} />
          <Route path="/proxy" element={<Suspense fallback={<PageLoader />}><ProxySettings /></Suspense>} />
          <Route path="/models" element={<Suspense fallback={<PageLoader />}><Models /></Suspense>} />
          <Route path="/api-keys" element={<Suspense fallback={<PageLoader />}><ApiKeys /></Suspense>} />
          <Route path="/logs" element={<Suspense fallback={<PageLoader />}><Logs /></Suspense>} />
          <Route path="/session" element={<Suspense fallback={<PageLoader />}><SessionManagement /></Suspense>} />
          <Route path="/settings" element={<Suspense fallback={<PageLoader />}><Settings /></Suspense>} />
          <Route path="/about" element={<Suspense fallback={<PageLoader />}><About /></Suspense>} />
        </Route>
      </Routes>
      <Toaster />
    </>
  )
}

export default App
