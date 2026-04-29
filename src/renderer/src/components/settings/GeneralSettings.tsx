import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { useSettingsStore, CloseBehavior, OAuthProxyMode } from '@/stores/settingsStore'
import { Bell, Minimize2, Power, Globe, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useState, useEffect } from 'react'
import { useToast } from '@/hooks/use-toast'

export function GeneralSettings() {
  const { t } = useTranslation()
  const {
    autoStart: savedAutoStart,
    setAutoStart: saveAutoStart,
    autoStartProxy: savedAutoStartProxy,
    setAutoStartProxy: saveAutoStartProxy,
    minimizeToTray: savedMinimizeToTray,
    setMinimizeToTray: saveMinimizeToTray,
    closeBehavior: savedCloseBehavior,
    setCloseBehavior: saveCloseBehavior,
    enableNotifications: savedEnableNotifications,
    setEnableNotifications: saveEnableNotifications,
    oauthProxyMode: savedOauthProxyMode,
    setOauthProxyMode: saveOauthProxyMode,
    saveSettings,
  } = useSettingsStore()
  const { toast } = useToast()

  const [autoStart, setAutoStartDraft] = useState(savedAutoStart)
  const [autoStartProxy, setAutoStartProxyDraft] = useState(savedAutoStartProxy)
  const [minimizeToTray, setMinimizeToTrayDraft] = useState(savedMinimizeToTray)
  const [closeBehavior, setCloseBehaviorDraft] = useState<CloseBehavior>(savedCloseBehavior)
  const [enableNotifications, setEnableNotificationsDraft] = useState(savedEnableNotifications)
  const [oauthProxyMode, setOauthProxyModeDraft] = useState<OAuthProxyMode>(savedOauthProxyMode)
  const [isSaving, setIsSaving] = useState(false)

  useEffect(() => {
    setAutoStartDraft(savedAutoStart)
    setAutoStartProxyDraft(savedAutoStartProxy)
    setMinimizeToTrayDraft(savedMinimizeToTray)
    setCloseBehaviorDraft(savedCloseBehavior)
    setEnableNotificationsDraft(savedEnableNotifications)
    setOauthProxyModeDraft(savedOauthProxyMode)
  }, [savedAutoStart, savedAutoStartProxy, savedMinimizeToTray, savedCloseBehavior, savedEnableNotifications, savedOauthProxyMode])

  const handleSave = async () => {
    setIsSaving(true)
    try {
      saveAutoStart(autoStart)
      saveAutoStartProxy(autoStartProxy)
      saveMinimizeToTray(minimizeToTray)
      saveCloseBehavior(closeBehavior)
      saveEnableNotifications(enableNotifications)
      saveOauthProxyMode(oauthProxyMode)
      await saveSettings()
      toast({ title: t('common.success'), description: t('settings.saveSuccess') })
    } catch {
      toast({ title: t('common.error'), description: t('settings.saveFailed'), variant: 'destructive' })
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Power className="h-5 w-5" />
            {t('settings.autoStart')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="auto-start">{t('settings.autoStart')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.autoStartHelp')}</p>
            </div>
            <Switch
              id="auto-start"
              checked={autoStart}
              onCheckedChange={setAutoStartDraft}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="auto-start-proxy">{t('settings.autoStartProxy')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.autoStartProxyHelp')}</p>
            </div>
            <Switch
              id="auto-start-proxy"
              checked={autoStartProxy}
              onCheckedChange={setAutoStartProxyDraft}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Minimize2 className="h-5 w-5" />
            {t('settings.closeBehavior')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="minimize-tray">{t('settings.minimizeToTray')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.minimizeToTrayHelp')}</p>
            </div>
            <Switch
              id="minimize-tray"
              checked={minimizeToTray}
              onCheckedChange={setMinimizeToTrayDraft}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('settings.closeBehavior')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.minimizeToTrayHelp')}</p>
            </div>
            <Select
              value={closeBehavior}
              onValueChange={(value) => setCloseBehaviorDraft(value as CloseBehavior)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={t('settings.closeBehavior')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="minimize">{t('settings.closeBehaviorMinimize')}</SelectItem>
                <SelectItem value="close">{t('settings.closeBehaviorClose')}</SelectItem>
                <SelectItem value="ask">{t('settings.closeBehaviorAsk')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            {t('settings.notifications')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="notifications">{t('settings.enableNotifications')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.enableNotificationsHelp')}</p>
            </div>
            <Switch
              id="notifications"
              checked={enableNotifications}
              onCheckedChange={setEnableNotificationsDraft}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            {t('settings.networkProxy')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>{t('settings.oauthProxyMode')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.oauthProxyModeHelp')}</p>
            </div>
            <Select
              value={oauthProxyMode}
              onValueChange={(value) => setOauthProxyModeDraft(value as OAuthProxyMode)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder={t('settings.oauthProxyMode')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="system">{t('settings.oauthProxySystem')}</SelectItem>
                <SelectItem value="none">{t('settings.oauthProxyNone')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={isSaving} className="flex items-center gap-2">
          <Save className="h-4 w-4" />
          {isSaving ? t('settings.saving') : t('settings.save')}
        </Button>
      </div>
    </div>
  )
}
