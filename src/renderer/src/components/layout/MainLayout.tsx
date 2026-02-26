import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'

export function MainLayout() {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[var(--bg-primary)]">
      <div className="bokeh-bg">
        <div className="bokeh-blob bokeh-blob-1" />
        <div className="bokeh-blob bokeh-blob-2" />
      </div>
      <Header />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
