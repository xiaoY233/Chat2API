import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useTheme } from '@/hooks/useTheme'
import { useSettingsStore, Theme, Language } from '@/stores/settingsStore'
import { Sun, Moon, PanelLeft, Languages } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export function AppearanceSettings() {
  const { t } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { 
    sidebarCollapsed, 
    setSidebarCollapsed, 
    language, 
    setLanguage 
  } = useSettingsStore()

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <Sun className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            {t('settings.theme')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>{t('settings.theme')}</Label>
            <div className="flex gap-2">
              {([
                { value: 'light', labelKey: 'settings.themeLight', icon: Sun },
                { value: 'dark', labelKey: 'settings.themeDark', icon: Moon },
              ] as const).map(({ value, labelKey, icon: Icon }) => (
                <Button
                  key={value}
                  variant={theme === value ? 'default' : 'outline'}
                  onClick={() => setTheme(value as Theme)}
                  className="flex items-center gap-2"
                >
                  <Icon className="h-4 w-4" />
                  {t(labelKey)}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <Languages className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            {t('settings.language')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)]">
            <div className="space-y-0.5">
              <Label htmlFor="language">{t('settings.language')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.languageSettingsDesc')}</p>
            </div>
            <Select
              value={language}
              onValueChange={(value) => setLanguage(value as Language)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={t('settings.language')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="zh-CN">{t('settings.languageZh')}</SelectItem>
                <SelectItem value="en-US">{t('settings.languageEn')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <PanelLeft className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            {t('settings.sidebar')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)]">
            <div className="space-y-0.5">
              <Label htmlFor="sidebar-collapsed">{t('settings.sidebarCollapsed')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.sidebarCollapsedHelp')}</p>
            </div>
            <Switch
              id="sidebar-collapsed"
              checked={sidebarCollapsed}
              onCheckedChange={setSidebarCollapsed}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
