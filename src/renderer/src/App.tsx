import { Routes, Route } from 'react-router-dom'
import { MainLayout } from '@/components/layout/MainLayout'
import { Dashboard } from '@/pages/Dashboard'
import { Providers } from '@/pages/Providers'
import { ProxySettings } from '@/pages/ProxySettings'
import { Models } from '@/pages/Models'
import ApiKeys from '@/pages/ApiKeys'
import Logs from '@/pages/Logs'
import { Settings } from '@/pages/Settings'
import { About } from '@/pages/About'
import { Toaster } from '@/components/ui/toaster'

function App() {
  return (
    <>
      <Routes>
        <Route element={<MainLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/providers" element={<Providers />} />
          <Route path="/proxy" element={<ProxySettings />} />
          <Route path="/models" element={<Models />} />
          <Route path="/api-keys" element={<ApiKeys />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/about" element={<About />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  )
}

export default App
