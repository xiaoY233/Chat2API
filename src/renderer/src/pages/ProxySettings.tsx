import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  ProxyConfigForm,
  LoadBalanceConfig,
  ProxyStatus,
  AdvancedConfig,
} from '@/components/proxy'
import { useProxyStore } from '@/stores/proxyStore'
import { Settings, Scale, Activity, Settings2 } from 'lucide-react'

export function ProxySettings() {
  const { t } = useTranslation()
  const { fetchAppConfig, fetchProxyStatus, fetchProxyStatistics } = useProxyStore()
  const hasLoadedRef = useRef(false)

  useEffect(() => {
    if (hasLoadedRef.current) return
    hasLoadedRef.current = true
    
    fetchAppConfig()
    fetchProxyStatus()
    fetchProxyStatistics()
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t('proxy.title')}</h2>
        <p className="text-muted-foreground">{t('proxy.description')}</p>
      </div>

      <Tabs defaultValue="status" className="w-full">
        <TabsList className="flex flex-wrap w-full gap-1 h-auto p-1">
          <TabsTrigger value="status" className="flex items-center gap-2 py-2 px-3 flex-1 min-w-0">
            <Activity className="h-4 w-4 flex-shrink-0" />
            <span className="hidden md:inline truncate">{t('proxy.statusMonitoring')}</span>
          </TabsTrigger>
          <TabsTrigger value="basic" className="flex items-center gap-2 py-2 px-3 flex-1 min-w-0">
            <Settings className="h-4 w-4 flex-shrink-0" />
            <span className="hidden md:inline truncate">{t('proxy.basicConfig')}</span>
          </TabsTrigger>
          <TabsTrigger value="loadbalance" className="flex items-center gap-2 py-2 px-3 flex-1 min-w-0">
            <Scale className="h-4 w-4 flex-shrink-0" />
            <span className="hidden md:inline truncate">{t('proxy.loadBalancing')}</span>
          </TabsTrigger>
          <TabsTrigger value="advanced" className="flex items-center gap-2 py-2 px-3 flex-1 min-w-0">
            <Settings2 className="h-4 w-4 flex-shrink-0" />
            <span className="hidden md:inline truncate">{t('proxy.advancedConfig')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="status" className="mt-6">
          <ProxyStatus />
        </TabsContent>

        <TabsContent value="basic" className="mt-6">
          <ProxyConfigForm />
        </TabsContent>

        <TabsContent value="loadbalance" className="mt-6">
          <LoadBalanceConfig />
        </TabsContent>

        <TabsContent value="advanced" className="mt-6">
          <AdvancedConfig />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default ProxySettings
