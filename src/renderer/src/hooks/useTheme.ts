import { useEffect, useMemo } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'

export function useTheme() {
  const { theme, setTheme } = useSettingsStore()

  const isDark = useMemo(() => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    }
    return theme === 'dark'
  }, [theme])

  useEffect(() => {
    const root = window.document.documentElement

    if (theme === 'system') {
      const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      root.setAttribute('data-theme', systemTheme)
    } else {
      root.setAttribute('data-theme', theme)
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

  const toggleTheme = () => {
    setTheme(isDark ? 'light' : 'dark')
  }

  return {
    theme,
    setTheme,
    toggleTheme,
    isDark,
  }
}
