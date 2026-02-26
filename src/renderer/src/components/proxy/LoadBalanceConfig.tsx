import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Slider } from '@/components/ui/slider'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useProxyStore, type AccountWeight } from '@/stores/proxyStore'
import { useToast } from '@/hooks/use-toast'
import type { LoadBalanceStrategy, Account, Provider } from '@/types/electron'
import { Scale, RefreshCw, Info } from 'lucide-react'

interface LoadBalanceConfigProps {
  onConfigChange?: () => void
}

export function LoadBalanceConfig({ onConfigChange }: LoadBalanceConfigProps) {
  const { t } = useTranslation()
  const {
    loadBalanceStrategy,
    setLoadBalanceStrategy,
    accountWeights,
    setAccountWeights,
    saveAppConfig,
    isLoading,
  } = useProxyStore()
  const { toast } = useToast()
  
  const initialStrategyRef = useRef<LoadBalanceStrategy>(loadBalanceStrategy)
  const initialWeightsRef = useRef<AccountWeight[]>(accountWeights)
  
  const [selectedStrategy, setSelectedStrategy] = useState<LoadBalanceStrategy>(loadBalanceStrategy)
  const [weights, setWeights] = useState<AccountWeight[]>(accountWeights)
  const [accounts, setAccounts] = useState<(Account & { provider?: Provider })[]>([])
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    fetchAccounts()
  }, [])

  useEffect(() => {
    setSelectedStrategy(loadBalanceStrategy)
    setWeights(accountWeights)
    initialStrategyRef.current = loadBalanceStrategy
    initialWeightsRef.current = accountWeights
  }, [])

  const fetchAccounts = async () => {
    try {
      const allAccounts = await window.electronAPI.accounts.getAll()
      const providers = await window.electronAPI.providers.getAll()
      
      const accountsWithProvider = allAccounts.map(account => ({
        ...account,
        provider: providers.find(p => p.id === account.providerId),
      }))
      
      setAccounts(accountsWithProvider)
      
      const defaultWeights = accountsWithProvider.map(account => ({
        accountId: account.id,
        weight: 100,
      }))
      
      const mergedWeights = defaultWeights.map(dw => {
        const existing = accountWeights.find(w => w.accountId === dw.accountId)
        return existing || dw
      })
      
      setWeights(mergedWeights)
    } catch (error) {
      console.error(t('proxy.failedToGetAccounts'), error)
    }
  }

  const handleStrategyChange = (value: LoadBalanceStrategy) => {
    setSelectedStrategy(value)
    setHasChanges(true)
    onConfigChange?.()
  }

  const handleWeightChange = (accountId: string, weight: number) => {
    setWeights(prev => prev.map(w =>
      w.accountId === accountId ? { ...w, weight } : w
    ))
    setHasChanges(true)
    onConfigChange?.()
  }

  const handleSave = async () => {
    setLoadBalanceStrategy(selectedStrategy)
    setAccountWeights(weights)
    
    const success = await saveAppConfig({
      loadBalanceStrategy: selectedStrategy,
    })

    if (success) {
      setHasChanges(false)
      toast({
        title: t('common.success'),
        description: t('proxy.loadBalanceConfig'),
      })
    } else {
      toast({
        title: t('common.error'),
        description: t('proxy.configSaveFailed'),
        variant: 'destructive',
      })
    }
  }

  const handleReset = () => {
    setSelectedStrategy(initialStrategyRef.current)
    setWeights(initialWeightsRef.current)
    setHasChanges(false)
  }

  const activeAccounts = accounts.filter(a => a.status === 'active')

  const getStrategyLabel = (strategy: LoadBalanceStrategy): string => {
    const labels: Record<LoadBalanceStrategy, string> = {
      'round-robin': t('proxy.roundRobin'),
      'fill-first': t('proxy.fillFirst'),
      'failover': t('proxy.failover'),
    }
    return labels[strategy]
  }

  const getStrategyDescription = (strategy: LoadBalanceStrategy): string => {
    const descriptions: Record<LoadBalanceStrategy, string> = {
      'round-robin': t('proxy.roundRobinDesc'),
      'fill-first': t('proxy.fillFirstDesc'),
      'failover': t('proxy.failoverDesc'),
    }
    return descriptions[strategy]
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Scale className="h-5 w-5 text-primary" />
            <CardTitle>{t('proxy.loadBalanceConfig')}</CardTitle>
          </div>
          {hasChanges && (
            <Badge variant="secondary" className="text-xs">
              {t('proxy.unsaved')}
            </Badge>
          )}
        </div>
        <CardDescription>{t('proxy.loadBalanceConfigDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="strategy">{t('proxy.loadBalanceStrategy')}</Label>
          <Select value={selectedStrategy} onValueChange={handleStrategyChange}>
            <SelectTrigger id="strategy">
              <SelectValue placeholder={t('proxy.selectStrategy')} />
            </SelectTrigger>
            <SelectContent>
              {(['round-robin', 'fill-first', 'failover'] as LoadBalanceStrategy[]).map((strategy) => (
                <SelectItem key={strategy} value={strategy}>
                  {getStrategyLabel(strategy)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <p className="text-sm text-muted-foreground">
              {getStrategyDescription(selectedStrategy)}
            </p>
          </div>
        </div>

        {activeAccounts.length > 0 && (
          <div className="space-y-4 pt-4 border-t">
            <div className="flex items-center justify-between">
              <Label>{t('proxy.accountWeightConfig')}</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={fetchAccounts}
                className="h-8 px-2"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1" />
                {t('common.refresh')}
              </Button>
            </div>
            
            <div className="space-y-4">
              {activeAccounts.map(account => {
                const weight = weights.find(w => w.accountId === account.id)?.weight || 100
                return (
                  <div key={account.id} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{account.name}</span>
                        {account.provider && (
                          <Badge variant="outline" className="text-xs">
                            {account.provider.name}
                          </Badge>
                        )}
                      </div>
                      <span className="text-sm text-muted-foreground w-12 text-right">
                        {weight}%
                      </span>
                    </div>
                    <Slider
                      value={[weight]}
                      onValueChange={([value]) => handleWeightChange(account.id, value)}
                      max={100}
                      step={5}
                      className="w-full"
                    />
                  </div>
                )
              })}
            </div>
            
            <p className="text-xs text-muted-foreground">
              {t('proxy.weightHelp')}
            </p>
          </div>
        )}

        {activeAccounts.length === 0 && (
          <div className="text-center py-6 text-muted-foreground">
            <p className="text-sm">{t('proxy.noActiveAccounts')}</p>
            <p className="text-xs mt-1">{t('proxy.addAndActivateAccount')}</p>
          </div>
        )}

        <div className="flex justify-end space-x-2 pt-4">
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={!hasChanges || isLoading}
          >
            {t('common.reset')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || isLoading}
          >
            {isLoading ? t('proxy.saving') : t('proxy.saveConfig')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default LoadBalanceConfig
