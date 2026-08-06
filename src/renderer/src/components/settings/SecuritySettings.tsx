import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useSettingsStore } from '@/stores/settingsStore'
import { Lock, FileText } from 'lucide-react'

export function SecuritySettings() {
  const { t } = useTranslation()
  const {
    credentialEncryption,
    setCredentialEncryption,
    logDesensitization,
    setLogDesensitization,
  } = useSettingsStore()

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" />
            {t('settings.credentialEncryption')}
          </CardTitle>
          <CardDescription>{t('settings.credentialEncryptionHelp')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="credential-encryption">{t('settings.credentialEncryption')}</Label>
            </div>
            <Switch
              id="credential-encryption"
              checked={credentialEncryption}
              onCheckedChange={setCredentialEncryption}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {t('settings.logDesensitization')}
          </CardTitle>
          <CardDescription>{t('settings.logDesensitizationHelp')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="log-desensitization">{t('settings.logDesensitization')}</Label>
            </div>
            <Switch
              id="log-desensitization"
              checked={logDesensitization}
              onCheckedChange={setLogDesensitization}
            />
          </div>
          <div className="rounded-md bg-muted p-4">
            <p className="text-sm font-medium mb-2">{t('settings.example')}</p>
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>Original: sk-1234567890abcdef1234567890abcdef</p>
              <p>Masked: sk-1234****cdef</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
