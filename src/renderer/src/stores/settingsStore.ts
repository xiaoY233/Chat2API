import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppConfig } from '@/types/electron'
import i18n from '@/i18n'

export type Theme = 'light' | 'dark' | 'system'
export type Language = 'zh-CN' | 'en-US'
export type CloseBehavior = 'minimize' | 'close' | 'ask'
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type OAuthProxyMode = 'system' | 'none'

interface SettingsState {
  theme: Theme
  setTheme: (theme: Theme) => void
  sidebarCollapsed: boolean
  toggleSidebar: () => void
  setSidebarCollapsed: (collapsed: boolean) => void
  proxyEnabled: boolean
  setProxyEnabled: (enabled: boolean) => void
  oauthProxyMode: OAuthProxyMode
  setOauthProxyMode: (mode: OAuthProxyMode) => void
  language: Language
  setLanguage: (language: Language) => void
  autoStart: boolean
  setAutoStart: (enabled: boolean) => void
  autoStartProxy: boolean
  setAutoStartProxy: (enabled: boolean) => void
  minimizeToTray: boolean
  setMinimizeToTray: (enabled: boolean) => void
  closeBehavior: CloseBehavior
  setCloseBehavior: (behavior: CloseBehavior) => void
  enableNotifications: boolean
  setEnableNotifications: (enabled: boolean) => void
  logLevel: LogLevel
  setLogLevel: (level: LogLevel) => void
  logRetentionDays: number
  setLogRetentionDays: (days: number) => void
  maxLogs: number
  setMaxLogs: (count: number) => void
  credentialEncryption: boolean
  setCredentialEncryption: (enabled: boolean) => void
  logDesensitization: boolean
  setLogDesensitization: (enabled: boolean) => void
  config: AppConfig | null
  setConfig: (config: AppConfig) => void
  updateConfig: (updates: Partial<AppConfig>) => Promise<void>
  fetchConfig: () => Promise<void>
  saveSettings: () => Promise<void>
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      setTheme: (theme) => set({ theme }),
      sidebarCollapsed: false,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
      proxyEnabled: false,
      setProxyEnabled: (enabled) => set({ proxyEnabled: enabled }),
      oauthProxyMode: 'system',
      setOauthProxyMode: (mode) => set({ oauthProxyMode: mode }),
      language: 'en-US',
      setLanguage: (language) => {
        set({ language })
        i18n.changeLanguage(language)
      },
      autoStart: false,
      setAutoStart: (enabled) => set({ autoStart: enabled }),
      autoStartProxy: false,
      setAutoStartProxy: (enabled) => set({ autoStartProxy: enabled }),
      minimizeToTray: true,
      setMinimizeToTray: (enabled) => set({ minimizeToTray: enabled }),
      closeBehavior: 'minimize',
      setCloseBehavior: (behavior) => set({ closeBehavior: behavior }),
      enableNotifications: true,
      setEnableNotifications: (enabled) => set({ enableNotifications: enabled }),
      logLevel: 'info',
      setLogLevel: (level) => set({ logLevel: level }),
      logRetentionDays: 30,
      setLogRetentionDays: (days) => set({ logRetentionDays: days }),
      maxLogs: 10000,
      setMaxLogs: (count) => set({ maxLogs: count }),
      credentialEncryption: false,
      setCredentialEncryption: (enabled) => set({ credentialEncryption: enabled }),
      logDesensitization: true,
      setLogDesensitization: (enabled) => set({ logDesensitization: enabled }),
      config: null,
      setConfig: (config) => set({ config }),
      updateConfig: async (updates) => {
        const currentConfig = get().config
        if (!currentConfig) return

        const newConfig = { ...currentConfig, ...updates }
        set({ config: newConfig })

        try {
          await window.electronAPI.config.update(updates)
        } catch (error) {
          console.error('Failed to update config:', error)
          set({ config: currentConfig })
        }
      },
      fetchConfig: async () => {
        try {
          const config = await window.electronAPI.config.get()
          set({
            config,
            theme: config.theme || 'system',
            autoStart: config.autoStart,
            autoStartProxy: config.autoStartProxy,
            minimizeToTray: config.minimizeToTray ?? true,
            oauthProxyMode: config.oauthProxyMode || 'system',
            logLevel: config.logLevel || 'info',
            logRetentionDays: config.logRetentionDays || 30,
          })
        } catch (error) {
          console.error('Failed to fetch config:', error)
        }
      },
      saveSettings: async () => {
        const state = get()
        try {
          await window.electronAPI.config.update({
            theme: state.theme,
            language: state.language,
            autoStart: state.autoStart,
            autoStartProxy: state.autoStartProxy,
            minimizeToTray: state.minimizeToTray,
            oauthProxyMode: state.oauthProxyMode,
            logLevel: state.logLevel,
            logRetentionDays: state.logRetentionDays,
          })
        } catch (error) {
          console.error('Failed to save settings:', error)
          throw error
        }
      },
    }),
    {
      name: 'chat2api-ui-settings',
      partialize: (state) => ({
        theme: state.theme,
        language: state.language,
        sidebarCollapsed: state.sidebarCollapsed,
        proxyEnabled: state.proxyEnabled,
        oauthProxyMode: state.oauthProxyMode,
        autoStart: state.autoStart,
        autoStartProxy: state.autoStartProxy,
        minimizeToTray: state.minimizeToTray,
        closeBehavior: state.closeBehavior,
        enableNotifications: state.enableNotifications,
        logLevel: state.logLevel,
        logRetentionDays: state.logRetentionDays,
        maxLogs: state.maxLogs,
        credentialEncryption: state.credentialEncryption,
        logDesensitization: state.logDesensitization,
      }),
      onRehydrateStorage: () => (state) => {
        if (state?.language) {
          i18n.changeLanguage(state.language)
        }
        // 从后端同步配置（theme、autoStart 等）
        useSettingsStore.getState().fetchConfig().catch((err) => {
          console.error('Failed to fetch config on rehydrate:', err)
        })
      },
    }
  )
)
