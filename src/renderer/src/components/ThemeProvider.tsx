import { useEffect, ReactNode } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'

interface ThemeProviderProps {
  children: ReactNode
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const theme = useSettingsStore((state) => state.theme)

  useEffect(() => {
    const root = window.document.documentElement

    const applyTheme = (t: 'light' | 'dark') => {
      root.setAttribute('data-theme', t)
    }

    const getSystemTheme = (): 'light' | 'dark' => {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }

    if (theme === 'system') {
      applyTheme(getSystemTheme())
    } else {
      applyTheme(theme)
    }
  }, [theme])

  useEffect(() => {
    if (theme !== 'system') return

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    
    const handleChange = (e: MediaQueryListEvent) => {
      const root = window.document.documentElement
      root.setAttribute('data-theme', e.matches ? 'dark' : 'light')
    }

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [theme])

  return <>{children}</>
}
