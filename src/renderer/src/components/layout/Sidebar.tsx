import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import {
  LayoutDashboard,
  Server,
  Settings2,
  FileText,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  Key,
  Cpu,
  Info,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/settingsStore'

interface NavItem {
  titleKey: string
  href: string
  icon: React.ComponentType<{ className?: string }>
}

const navItems: NavItem[] = [
  { titleKey: 'nav.dashboard', href: '/', icon: LayoutDashboard },
  { titleKey: 'nav.providers', href: '/providers', icon: Server },
  { titleKey: 'nav.proxy', href: '/proxy', icon: Settings2 },
  { titleKey: 'nav.models', href: '/models', icon: Cpu },
  { titleKey: 'nav.apiKeys', href: '/api-keys', icon: Key },
  { titleKey: 'nav.logs', href: '/logs', icon: FileText },
  { titleKey: 'nav.settings', href: '/settings', icon: Settings },
  { titleKey: 'nav.about', href: '/about', icon: Info },
]

function Tooltip({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tooltip-container">
      {children}
      <div className="tooltip-content">
        {label}
        <div className="tooltip-arrow" />
      </div>
    </div>
  )
}

export function Sidebar() {
  const { t } = useTranslation()
  const { sidebarCollapsed, toggleSidebar } = useSettingsStore()

  const NavButton = ({ item }: { item: NavItem }) => {
    const title = t(item.titleKey)
    const buttonContent = (
      <NavLink
        to={item.href}
        className={({ isActive }) =>
          cn(
            'sidebar-nav-item',
            sidebarCollapsed ? 'collapsed' : 'expanded',
            isActive ? 'active' : 'inactive'
          )
        }
      >
        <item.icon className="h-5 w-5 flex-shrink-0" />
        <span
          className={cn(
            'whitespace-nowrap transition-all duration-300',
            sidebarCollapsed ? 'w-0 opacity-0 overflow-hidden' : 'w-auto opacity-100'
          )}
        >
          {title}
        </span>
      </NavLink>
    )
    
    if (sidebarCollapsed) {
      return <Tooltip label={title}>{buttonContent}</Tooltip>
    }
    return buttonContent
  }

  return (
    <aside
      className={cn(
        'glass-sidebar flex flex-col transition-all duration-300 ease-in-out',
        sidebarCollapsed ? 'w-[72px]' : 'w-64'
      )}
    >
      <nav className="flex-1 p-3 space-y-1 overflow-x-hidden overflow-y-auto pt-5">
        {navItems.map((item) => (
          <NavButton key={item.href} item={item} />
        ))}
      </nav>

      <div className="mx-4 border-t border-[var(--glass-border)] opacity-50" />

      <div className="p-3 overflow-hidden flex justify-center">
        <button
          className="sidebar-collapse-btn"
          onClick={toggleSidebar}
          aria-label={sidebarCollapsed ? t('settings.sidebarCollapsedHelp') : t('settings.sidebarCollapsedHelp')}
          title={sidebarCollapsed ? t('settings.sidebarCollapsedHelp') : t('settings.sidebarCollapsedHelp')}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="h-5 w-5" />
          ) : (
            <PanelLeftClose className="h-5 w-5" />
          )}
        </button>
      </div>
    </aside>
  )
}
