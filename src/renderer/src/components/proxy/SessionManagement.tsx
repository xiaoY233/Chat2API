import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { useToast } from '@/hooks/use-toast'
import { Settings2 } from 'lucide-react'

export function SessionManagement() {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [config, setConfig] = useState<{
    mode: 'single'
    sessionTimeout: number
    maxMessagesPerSession: number
    deleteAfterTimeout: boolean
    maxSessionsPerAccount: number
  }>({
    mode: 'single',
    sessionTimeout: 30,
    maxMessagesPerSession: 50,
    deleteAfterTimeout: false,
    maxSessionsPerAccount: 3,
  })

  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async () => {
    try {
      const sessionConfig = await window.electronAPI.session.getConfig()
      setConfig(sessionConfig)
    } catch (error) {
      console.error('Failed to load session config:', error)
    }
  }

  const handleConfigChange = (updates: Partial<typeof config>) => {
    setConfig(prev => ({ ...prev, ...updates }))
    setHasChanges(true)
  }

  const saveConfig = async () => {
    try {
      await window.electronAPI.session.updateConfig(config)
      setHasChanges(false)
      toast({
        title: t('common.success'),
        description: t('session.configSaved'),
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: t('session.configSaveFailed'),
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings2 className="h-5 w-5" />
            {t('session.sessionSettings')}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between p-4 bg-muted/30 rounded-lg">
            <div className="space-y-0.5">
              <Label htmlFor="delete-after-chat">{t('session.deleteAfterChat')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('session.deleteAfterChatHint')}
              </p>
            </div>
            <Switch
              id="delete-after-chat"
              checked={config.deleteAfterTimeout}
              onCheckedChange={(checked) => handleConfigChange({ deleteAfterTimeout: checked })}
            />
          </div>

          {hasChanges && (
            <div className="flex justify-end pt-4 border-t">
              <Button onClick={saveConfig}>
                {t('common.save')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
