import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  AppearanceSettings,
  GeneralSettings,
  DataManagement,
  SecuritySettings,
} from '@/components/settings'
import { Sun, Settings as SettingsIcon, Database, Shield } from 'lucide-react'

export function Settings() {
  const { t } = useTranslation()

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t('settings.title')}</h2>
        <p className="text-muted-foreground">{t('settings.description')}</p>
      </div>

      <Tabs defaultValue="appearance" className="w-full">
        <TabsList className="grid w-full grid-cols-4 h-auto">
          <TabsTrigger value="appearance" className="flex items-center gap-2 py-2">
            <Sun className="h-4 w-4" />
            <span className="hidden sm:inline">{t('settings.appearance')}</span>
          </TabsTrigger>
          <TabsTrigger value="general" className="flex items-center gap-2 py-2">
            <SettingsIcon className="h-4 w-4" />
            <span className="hidden sm:inline">{t('settings.generalSettings')}</span>
          </TabsTrigger>
          <TabsTrigger value="data" className="flex items-center gap-2 py-2">
            <Database className="h-4 w-4" />
            <span className="hidden sm:inline">{t('settings.data')}</span>
          </TabsTrigger>
          <TabsTrigger value="security" className="flex items-center gap-2 py-2">
            <Shield className="h-4 w-4" />
            <span className="hidden sm:inline">{t('settings.security')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="appearance" className="mt-6">
          <AppearanceSettings />
        </TabsContent>

        <TabsContent value="general" className="mt-6">
          <GeneralSettings />
        </TabsContent>

        <TabsContent value="data" className="mt-6">
          <DataManagement />
        </TabsContent>

        <TabsContent value="security" className="mt-6">
          <SecuritySettings />
        </TabsContent>
      </Tabs>
    </div>
  )
}
