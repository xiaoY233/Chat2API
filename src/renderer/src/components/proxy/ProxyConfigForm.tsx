import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useProxyStore } from '@/stores/proxyStore'
import { useToast } from '@/hooks/use-toast'
import { Server, AlertCircle, CheckCircle2 } from 'lucide-react'

interface ProxyConfigFormProps {
  onConfigChange?: () => void
}

interface FormErrors {
  port?: string
  host?: string
  corsOrigin?: string
}

export function ProxyConfigForm({ onConfigChange }: ProxyConfigFormProps) {
  const { t } = useTranslation()
  const { proxyConfig, setProxyConfig, saveAppConfig, isLoading } = useProxyStore()
  const { toast } = useToast()
  
  const initialConfigRef = useRef({
    port: proxyConfig.port.toString(),
    host: proxyConfig.host,
    enableCors: proxyConfig.enableCors,
    corsOrigin: proxyConfig.corsOrigin,
  })
  
  const [formData, setFormData] = useState({
    port: proxyConfig.port.toString(),
    host: proxyConfig.host,
    enableCors: proxyConfig.enableCors,
    corsOrigin: proxyConfig.corsOrigin,
  })
  
  const [errors, setErrors] = useState<FormErrors>({})
  const [hasChanges, setHasChanges] = useState(false)

  useEffect(() => {
    const newFormData = {
      port: proxyConfig.port.toString(),
      host: proxyConfig.host,
      enableCors: proxyConfig.enableCors,
      corsOrigin: proxyConfig.corsOrigin,
    }
    setFormData(newFormData)
    initialConfigRef.current = newFormData
  }, [])

  const validatePort = (value: string): string | undefined => {
    const port = parseInt(value, 10)
    if (isNaN(port)) return t('proxy.portMustBeNumber')
    if (port < 1 || port > 65535) return t('proxy.portRangeError')
    if (port < 1024 && port !== 80 && port !== 443) {
      return t('proxy.portPrivilege')
    }
    return undefined
  }

  const validateHost = (value: string): string | undefined => {
    if (!value.trim()) return t('proxy.bindAddressEmpty')
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/
    const ipv6Regex = /^\[?[0-9a-fA-F:]+\]?$/
    const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
    
    if (!ipv4Regex.test(value) && !ipv6Regex.test(value) && !hostnameRegex.test(value) && value !== 'localhost') {
      return t('proxy.invalidIpOrHostname')
    }
    return undefined
  }

  const validateCorsOrigin = (value: string): string | undefined => {
    if (!formData.enableCors) return undefined
    if (!value.trim()) return t('proxy.corsOriginEmpty')
    if (value !== '*') {
      const origins = value.split(',').map(o => o.trim())
      for (const origin of origins) {
        try {
          new URL(origin)
        } catch {
          return `${t('proxy.invalidUrl')}: ${origin}`
        }
      }
    }
    return undefined
  }

  const handlePortChange = (value: string) => {
    setFormData(prev => ({ ...prev, port: value }))
    const error = validatePort(value)
    setErrors(prev => ({ ...prev, port: error }))
    setHasChanges(true)
    onConfigChange?.()
  }

  const handleHostChange = (value: string) => {
    setFormData(prev => ({ ...prev, host: value }))
    const error = validateHost(value)
    setErrors(prev => ({ ...prev, host: error }))
    setHasChanges(true)
    onConfigChange?.()
  }

  const handleCorsToggle = (enabled: boolean) => {
    setFormData(prev => ({ ...prev, enableCors: enabled }))
    if (enabled) {
      const error = validateCorsOrigin(formData.corsOrigin)
      setErrors(prev => ({ ...prev, corsOrigin: error }))
    } else {
      setErrors(prev => ({ ...prev, corsOrigin: undefined }))
    }
    setHasChanges(true)
    onConfigChange?.()
  }

  const handleCorsOriginChange = (value: string) => {
    setFormData(prev => ({ ...prev, corsOrigin: value }))
    const error = validateCorsOrigin(value)
    setErrors(prev => ({ ...prev, corsOrigin: error }))
    setHasChanges(true)
    onConfigChange?.()
  }

  const handleSave = async () => {
    const portError = validatePort(formData.port)
    const hostError = validateHost(formData.host)
    const corsError = validateCorsOrigin(formData.corsOrigin)
    
    if (portError || hostError || corsError) {
      setErrors({
        port: portError,
        host: hostError,
        corsOrigin: corsError,
      })
      toast({
        title: t('proxy.validationFailed'),
        description: t('proxy.fixFormErrors'),
        variant: 'destructive',
      })
      return
    }

    const newConfig = {
      port: parseInt(formData.port, 10),
      host: formData.host,
      enableCors: formData.enableCors,
      corsOrigin: formData.corsOrigin,
    }

    setProxyConfig(newConfig)
    
    const success = await saveAppConfig({
      proxyPort: newConfig.port,
    })

    if (success) {
      setHasChanges(false)
      toast({
        title: t('common.success'),
        description: t('proxy.proxyConfigUpdated'),
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
    setFormData(initialConfigRef.current)
    setErrors({})
    setHasChanges(false)
  }

  const isValid = !errors.port && !errors.host && !errors.corsOrigin

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <CardTitle>{t('proxy.basicConfig')}</CardTitle>
          </div>
          {hasChanges && (
            <Badge variant="secondary" className="text-xs">
              {t('proxy.unsaved')}
            </Badge>
          )}
        </div>
        <CardDescription>{t('proxy.basicConfigDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="port" className="flex items-center gap-2">
              {t('proxy.listeningPort')}
              {errors.port && (
                <span className="text-destructive text-xs flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {errors.port}
                </span>
              )}
              {!errors.port && formData.port && (
                <CheckCircle2 className="h-3 w-3 text-green-500" />
              )}
            </Label>
            <Input
              id="port"
              type="number"
              placeholder="8080"
              value={formData.port}
              onChange={(e) => handlePortChange(e.target.value)}
              className={errors.port ? 'border-destructive' : ''}
            />
            <p className="text-xs text-muted-foreground">
              {t('proxy.portRange')}
            </p>
          </div>
          
          <div className="space-y-2">
            <Label htmlFor="host" className="flex items-center gap-2">
              {t('proxy.bindAddress')}
              {errors.host && (
                <span className="text-destructive text-xs flex items-center gap-1">
                  <AlertCircle className="h-3 w-3" />
                  {errors.host}
                </span>
              )}
              {!errors.host && formData.host && (
                <CheckCircle2 className="h-3 w-3 text-green-500" />
              )}
            </Label>
            <Input
              id="host"
              placeholder="127.0.0.1"
              value={formData.host}
              onChange={(e) => handleHostChange(e.target.value)}
              className={errors.host ? 'border-destructive' : ''}
            />
            <p className="text-xs text-muted-foreground">
              {t('proxy.bindAddressHelp')}
            </p>
          </div>
        </div>

        <div className="space-y-4 pt-4 border-t">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="cors-toggle">{t('proxy.enableCors')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('proxy.enableCorsHelp')}
              </p>
            </div>
            <Switch
              id="cors-toggle"
              checked={formData.enableCors}
              onCheckedChange={handleCorsToggle}
            />
          </div>

          {formData.enableCors && (
            <div className="space-y-2">
              <Label htmlFor="cors-origin" className="flex items-center gap-2">
                {t('proxy.corsOrigin')}
                {errors.corsOrigin && (
                  <span className="text-destructive text-xs flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    {errors.corsOrigin}
                  </span>
                )}
              </Label>
              <Input
                id="cors-origin"
                placeholder="* or https://example.com,https://another.com"
                value={formData.corsOrigin}
                onChange={(e) => handleCorsOriginChange(e.target.value)}
                className={errors.corsOrigin ? 'border-destructive' : ''}
              />
              <p className="text-xs text-muted-foreground">
                {t('proxy.corsOriginHelp')}
              </p>
            </div>
          )}
        </div>

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
            disabled={!hasChanges || !isValid || isLoading}
          >
            {isLoading ? t('proxy.saving') : t('proxy.saveConfig')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

export default ProxyConfigForm
