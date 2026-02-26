import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Check, Plus, ArrowRight, Loader2, ExternalLink, AlertCircle, CheckCircle2, ArrowLeft } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { BuiltinProviderConfig, ProviderVendor } from '@/types/electron'
import { cn } from '@/lib/utils'
import deepseekIcon from '@/assets/providers/deepseek.svg'
import glmIcon from '@/assets/providers/glm.svg'
import kimiIcon from '@/assets/providers/kimi.svg'
import minimaxIcon from '@/assets/providers/minimax.svg'
import qwenIcon from '@/assets/providers/qwen.svg'
import zaiIcon from '@/assets/providers/zai.svg'

interface AddProviderDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  builtinProviders: BuiltinProviderConfig[]
  onSelectBuiltin: (provider: BuiltinProviderConfig, credentials: Record<string, string>) => void
  onCreateCustom: () => void
  onValidateToken?: (providerId: string, credentials: Record<string, string>) => Promise<{
    valid: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>
}

const providerIcons: Record<string, string> = {
  deepseek: deepseekIcon,
  glm: glmIcon,
  kimi: kimiIcon,
  minimax: minimaxIcon,
  qwen: qwenIcon,
  'qwen-ai': qwenIcon,
  zai: zaiIcon,
}

function mapOAuthCredentials(providerId: string | undefined, credentials: Record<string, string>): Record<string, string> {
  if (!providerId) return credentials

  const credentialKeyMap: Record<string, string> = {
    'glm': 'chatglm_refresh_token',
    'deepseek': 'userToken',
    'qwen': 'tongyi_sso_ticket',
    'qwen-ai': 'tongyi_sso_ticket',
    'zai': 'tongyi_sso_ticket',
  }

  const providerFieldNames: Record<string, string> = {
    'glm': 'refresh_token',
    'deepseek': 'token',
    'qwen': 'ticket',
    'qwen-ai': 'ticket',
    'zai': 'ticket',
  }

  const oauthKey = credentialKeyMap[providerId]
  if (oauthKey && credentials[oauthKey]) {
    const fieldName = providerFieldNames[providerId]
    if (fieldName) {
      let tokenValue = credentials[oauthKey]
      if (providerId === 'deepseek' && tokenValue && tokenValue.startsWith('{') && tokenValue.endsWith('}')) {
        try {
          const parsed = JSON.parse(tokenValue)
          if (parsed.value) {
            tokenValue = parsed.value
          }
        } catch (e) {
          console.error('[AddProviderDialog] Error parsing JSON token:', e)
        }
      }
      return { [fieldName]: tokenValue }
    }
  }

  return credentials
}

export function AddProviderDialog({
  open,
  onOpenChange,
  builtinProviders,
  onSelectBuiltin,
  onCreateCustom,
  onValidateToken,
}: AddProviderDialogProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState<1 | 2>(1)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set())
  const [activeTab, setActiveTab] = useState<string>('manual')
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [isValidating, setIsValidating] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isOAuthLoading, setIsOAuthLoading] = useState(false)
  const [validationResult, setValidationResult] = useState<{
    valid?: boolean
    error?: string
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>({})
  const [oauthStatus, setOAuthStatus] = useState<string>('')

  const DEFAULT_BUILTIN_PROVIDERS: BuiltinProviderConfig[] = [
    {
      id: 'deepseek',
      name: t('deepseek.name'),
      type: 'builtin',
      authType: 'userToken',
      apiEndpoint: 'https://chat.deepseek.com/api',
      enabled: true,
      description: t('deepseek.description'),
      supportedModels: ['DeepSeek-V3.2', 'DeepSeek-R1', 'DeepSeek-Search', 'DeepSeek-R1-Search'],
      modelMappings: {
        'DeepSeek-V3.2': 'deepseek-chat',
        'DeepSeek-R1': 'deepseek-chat',
        'DeepSeek-Search': 'deepseek-chat',
        'DeepSeek-R1-Search': 'deepseek-chat',
      },
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': 'https://chat.deepseek.com',
        'Referer': 'https://chat.deepseek.com/',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      credentialFields: [
        {
          name: 'token',
          label: t('deepseek.userToken'),
          type: 'password',
          required: true,
          placeholder: t('deepseek.userTokenPlaceholder'),
          helpText: t('deepseek.userTokenHelp'),
        },
      ],
    },
    {
      id: 'glm',
      name: t('glm.name'),
      type: 'builtin',
      authType: 'refresh_token',
      apiEndpoint: 'https://chatglm.cn/api',
      enabled: true,
      description: t('glm.description'),
      supportedModels: ['GLM-5', 'GLM-5-Flash', 'GLM-4-Plus', 'GLM-4-Flash', 'GLM-Zero-Preview', 'GLM-DeepResearch'],
      modelMappings: {
        'GLM-5': 'glm-5',
        'GLM-5-Flash': 'glm-5-flash',
        'GLM-4-Plus': 'glm-4-plus',
        'GLM-4-Flash': 'glm-4-flash',
        'GLM-Zero-Preview': 'glm-zero-preview',
        'GLM-DeepResearch': 'glm-deepresearch',
      },
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Origin': 'https://chatglm.cn',
        'Referer': 'https://chatglm.cn/',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      credentialFields: [
        {
          name: 'refresh_token',
          label: t('glm.refreshToken'),
          type: 'password',
          required: true,
          placeholder: t('glm.refreshTokenPlaceholder'),
          helpText: t('glm.refreshTokenHelp'),
        },
      ],
    },
    {
      id: 'kimi',
      name: t('kimi.name'),
      type: 'builtin',
      authType: 'jwt',
      apiEndpoint: 'https://www.kimi.com/api',
      enabled: true,
      description: t('kimi.description'),
      supportedModels: ['kimi', 'kimi-search', 'kimi-research', 'kimi-k1'],
      headers: {
        'Content-Type': 'application/json',
        'Accept': '*/*',
        'Origin': 'https://www.kimi.com',
        'Referer': 'https://www.kimi.com/',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      credentialFields: [
        {
          name: 'token',
          label: t('kimi.accessToken'),
          type: 'password',
          required: true,
          placeholder: t('kimi.accessTokenPlaceholder'),
          helpText: t('kimi.accessTokenHelp'),
        },
      ],
    },
    {
      id: 'minimax',
      name: t('minimax.name'),
      type: 'builtin',
      authType: 'jwt',
      apiEndpoint: 'https://agent.minimaxi.com',
      enabled: true,
      description: t('minimax.description'),
      supportedModels: ['MiniMax-M2.5'],
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://agent.minimaxi.com',
        'Referer': 'https://agent.minimaxi.com/',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      credentialFields: [
        {
          name: 'token',
          label: t('minimax.token'),
          type: 'password',
          required: true,
          placeholder: t('minimax.tokenPlaceholder'),
          helpText: t('minimax.tokenHelp'),
        },
        {
          name: 'realUserID',
          label: t('minimax.realUserID'),
          type: 'text',
          required: false,
          placeholder: t('minimax.realUserIDPlaceholder'),
          helpText: t('minimax.realUserIDHelp'),
        },
      ],
    },
    {
      id: 'qwen',
      name: t('qwen.name'),
      type: 'builtin',
      authType: 'tongyi_sso_ticket',
      apiEndpoint: 'https://qianwen.biz.aliyun.com/api',
      enabled: true,
      description: t('qwen.description'),
      supportedModels: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://tongyi.aliyun.com',
        'Referer': 'https://tongyi.aliyun.com/',
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      credentialFields: [
        {
          name: 'ticket',
          label: t('qwen.ssoTicket'),
          type: 'password',
          required: true,
          placeholder: t('qwen.ssoTicketPlaceholder'),
          helpText: t('qwen.ssoTicketHelp'),
        },
      ],
    },
  ]

  const providers = builtinProviders.length > 0 ? builtinProviders : DEFAULT_BUILTIN_PROVIDERS

  const getProviderName = (provider: BuiltinProviderConfig) => {
    return t(`${provider.id}.name`, { defaultValue: provider.name })
  }

  const getProviderDescription = (provider: BuiltinProviderConfig) => {
    return t(`${provider.id}.description`, { defaultValue: provider.description })
  }

  const filteredProviders = providers.filter((provider) =>
    getProviderName(provider).toLowerCase().includes(searchQuery.toLowerCase()) ||
    getProviderDescription(provider)?.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const selectedProviderData = selectedProvider 
    ? providers.find((p) => p.id === selectedProvider) 
    : null

  const supportsOAuth = selectedProviderData && ['deepseek', 'glm', 'kimi', 'minimax', 'qwen', 'qwen-ai', 'zai'].includes(selectedProviderData.id)

  const toggleModelExpansion = (providerId: string) => {
    setExpandedModels(prev => {
      const newSet = new Set(prev)
      if (newSet.has(providerId)) {
        newSet.delete(providerId)
      } else {
        newSet.add(providerId)
      }
      return newSet
    })
  }

  useEffect(() => {
    if (!open) {
      setStep(1)
      setSelectedProvider(null)
      setSearchQuery('')
      setCredentials({})
      setValidationResult({})
      setActiveTab('manual')
      setIsOAuthLoading(false)
      setOAuthStatus('')
    }
  }, [open])

  const handleCredentialChange = (fieldName: string, value: string) => {
    setCredentials(prev => ({
      ...prev,
      [fieldName]: value,
    }))
    setValidationResult({})
  }

  const handleValidate = async () => {
    if (!selectedProviderData || !onValidateToken) return

    const credentialFields = selectedProviderData.credentialFields || []
    const requiredFields = credentialFields.filter(f => f.required)
    const missingFields = requiredFields.filter(f => !credentials[f.name])
    
    if (missingFields.length > 0) {
      setValidationResult({
        valid: false,
        error: t('providers.fillRequiredFields', { fields: missingFields.map(f => f.label).join(', ') }),
      })
      return
    }

    setIsValidating(true)
    setValidationResult({})

    try {
      const result = await onValidateToken(selectedProviderData.id, credentials)
      setValidationResult(result)
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : t('providers.validateFailed'),
      })
    } finally {
      setIsValidating(false)
    }
  }

  const handleSubmit = async () => {
    if (!selectedProviderData) return

    const credentialFields = selectedProviderData.credentialFields || []
    const requiredFields = credentialFields.filter(f => f.required)
    const missingFields = requiredFields.filter(f => !credentials[f.name])
    
    if (missingFields.length > 0) {
      setValidationResult({
        valid: false,
        error: t('providers.fillRequiredFields', { fields: missingFields.map(f => f.label).join(', ') }),
      })
      return
    }

    setIsSubmitting(true)

    try {
      await onSelectBuiltin(selectedProviderData, credentials)
      onOpenChange(false)
      setStep(1)
      setSelectedProvider(null)
      setSearchQuery('')
      setCredentials({})
      setValidationResult({})
    } catch (error) {
      setValidationResult({
        valid: false,
        error: error instanceof Error ? error.message : t('providers.saveFailed'),
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleOpenOAuthBrowser = async () => {
    if (!selectedProviderData) return
    
    setIsOAuthLoading(true)
    setOAuthStatus(t('providers.openingLoginWindow'))
    
    try {
      const result = await window.electronAPI?.oauth.startInAppLogin(
        selectedProviderData.id,
        selectedProviderData.id as ProviderVendor
      )
      
      if (result?.success && result.credentials) {
        const mappedCredentials = mapOAuthCredentials(selectedProviderData?.id, result.credentials)
        setCredentials(mappedCredentials)
        setOAuthStatus(t('providers.loginSuccess'))
        
        setValidationResult({
          valid: true,
          userInfo: result.accountInfo
        })
      } else {
        const errorMsg = result?.error || ''
        const translatedError = errorMsg === 'Login window was closed' 
          ? t('providers.loginWindowClosed')
          : errorMsg === 'A login window is already open'
            ? t('providers.loginWindowAlreadyOpen')
            : errorMsg.includes('Guest account') 
              ? t('providers.guestAccountNotAllowed')
              : errorMsg || t('providers.loginFailed')
        setOAuthStatus(translatedError)
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : t('providers.loginFailed')
      setOAuthStatus(errorMessage)
    } finally {
      setIsOAuthLoading(false)
    }
  }

  const handleCreateCustom = () => {
    onCreateCustom()
    setSelectedProvider(null)
    setSearchQuery('')
  }

  const handleNextStep = () => {
    if (selectedProvider) {
      setStep(2)
    }
  }

  const handleBackStep = () => {
    setStep(1)
    setCredentials({})
    setValidationResult({})
    setActiveTab('manual')
    setOAuthStatus('')
  }

  const renderCredentialFields = () => {
    if (!selectedProviderData) return null

    const credentialFields = selectedProviderData.credentialFields || []

    return (
      <div className="space-y-4">
        {credentialFields.map((field) => {
          const getFieldTranslation = () => {
            const translations: Record<string, Record<string, { label: string; placeholder: string; helpText: string }>> = {
              deepseek: {
                token: {
                  label: t('deepseek.userToken'),
                  placeholder: t('deepseek.userTokenPlaceholder'),
                  helpText: t('deepseek.userTokenHelp'),
                },
              },
              glm: {
                refresh_token: {
                  label: t('glm.refreshToken'),
                  placeholder: t('glm.refreshTokenPlaceholder'),
                  helpText: t('glm.refreshTokenHelp'),
                },
              },
              kimi: {
                token: {
                  label: t('kimi.accessToken'),
                  placeholder: t('kimi.accessTokenPlaceholder'),
                  helpText: t('kimi.accessTokenHelp'),
                },
              },
              minimax: {
                token: {
                  label: t('minimax.token'),
                  placeholder: t('minimax.tokenPlaceholder'),
                  helpText: t('minimax.tokenHelp'),
                },
                realUserID: {
                  label: t('minimax.realUserID'),
                  placeholder: t('minimax.realUserIDPlaceholder'),
                  helpText: t('minimax.realUserIDHelp'),
                },
              },
              qwen: {
                ticket: {
                  label: t('qwen.ssoTicket'),
                  placeholder: t('qwen.ssoTicketPlaceholder'),
                  helpText: t('qwen.ssoTicketHelp'),
                },
              },
              'qwen-ai': {
                token: {
                  label: t('qwen-ai.token'),
                  placeholder: t('qwen-ai.tokenPlaceholder'),
                  helpText: t('qwen-ai.tokenHelp'),
                },
                cookies: {
                  label: t('qwen-ai.cookies'),
                  placeholder: t('qwen-ai.cookiesPlaceholder'),
                  helpText: t('qwen-ai.cookiesHelp'),
                },
              },
              zai: {
                token: {
                  label: t('zai.token'),
                  placeholder: t('zai.tokenPlaceholder'),
                  helpText: t('zai.tokenHelp'),
                },
              },
            }

            const providerTranslations = translations[selectedProviderData.id]
            if (providerTranslations && providerTranslations[field.name]) {
              return providerTranslations[field.name]
            }

            return { label: field.label, placeholder: field.placeholder, helpText: field.helpText }
          }

          const translated = getFieldTranslation()

          return (
            <div key={field.name} className="space-y-2">
              <div className="flex items-center gap-2">
                <Label htmlFor={field.name}>{translated.label}</Label>
                {field.required && (
                  <Badge variant="outline" className="text-xs">{t('providers.required')}</Badge>
                )}
              </div>
              {field.type === 'textarea' ? (
                <textarea
                  id={field.name}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  placeholder={translated.placeholder}
                  value={credentials[field.name] || ''}
                  onChange={(e) => handleCredentialChange(field.name, e.target.value)}
                />
              ) : (
                <Input
                  id={field.name}
                  type={field.type}
                  placeholder={translated.placeholder}
                  value={credentials[field.name] || ''}
                  onChange={(e) => handleCredentialChange(field.name, e.target.value)}
                />
              )}
              {translated.helpText && (
                <p className="text-xs text-muted-foreground">{translated.helpText}</p>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  const renderStep1 = () => (
    <Tabs defaultValue="builtin" className="mt-4">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="builtin">{t('providers.builtinProviders')}</TabsTrigger>
        <TabsTrigger value="custom" disabled className="gap-1">
          {t('providers.customProviders')}
          <span className="text-[10px] text-muted-foreground">({t('providers.customProviderNotSupported')})</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="builtin" className="mt-4">
        <div className="space-y-4">
          <Input
            placeholder={t('providers.searchProviders')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />

          <ScrollArea className="h-[300px]">
            <div className="grid gap-2 pr-4">
              {filteredProviders.map((provider) => (
                <div
                  key={provider.id}
                  className={cn(
                    'flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors',
                    selectedProvider === provider.id
                      ? 'border-primary bg-primary/5'
                      : 'hover:bg-muted/50'
                  )}
                  onClick={() => setSelectedProvider(provider.id)}
                >
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden">
                      {providerIcons[provider.id] ? (
                        <img 
                          src={providerIcons[provider.id]} 
                          alt={provider.name}
                          className="h-8 w-8 object-contain"
                        />
                      ) : (
                        <span className="text-xl">🔌</span>
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{getProviderName(provider)}</span>
                        <Badge variant="outline" className="text-xs">
                          {t('providers.builtin')}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {getProviderDescription(provider)}
                      </p>
                      <div className="flex items-center gap-1 mt-1 flex-wrap">
                        {expandedModels.has(provider.id) ? (
                          provider.supportedModels?.map((model) => (
                            <Badge key={model} variant="secondary" className="text-xs">
                              {model}
                            </Badge>
                          ))
                        ) : (
                          <>
                            {provider.supportedModels?.slice(0, 3).map((model) => (
                              <Badge key={model} variant="secondary" className="text-xs">
                                {model}
                              </Badge>
                            ))}
                          </>
                        )}
                        {(provider.supportedModels?.length || 0) > 3 && (
                          <Badge 
                            variant="secondary" 
                            className="text-xs cursor-pointer hover:bg-secondary/80"
                            onClick={(e) => {
                              e.stopPropagation()
                              toggleModelExpansion(provider.id)
                            }}
                          >
                            {expandedModels.has(provider.id) ? t('providers.collapse') : `+${(provider.supportedModels?.length || 0) - 3}`}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  {selectedProvider === provider.id && (
                    <Check className="h-5 w-5 text-primary" />
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      </TabsContent>

      <TabsContent value="custom" className="mt-4">
        <div className="flex flex-col items-center justify-center py-8 space-y-4">
          <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center">
            <Plus className="h-8 w-8 text-primary" />
          </div>
          <div className="text-center">
            <h3 className="font-medium">{t('providers.createCustomProvider')}</h3>
            <p className="text-sm text-muted-foreground mt-1">
              {t('providers.createCustomProviderDesc')}
            </p>
          </div>
          <Button onClick={handleCreateCustom}>
            {t('providers.startCreating')}
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </TabsContent>
    </Tabs>
  )

  const renderStep2 = () => (
    <div className="mt-4 space-y-4">
      <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden">
          {providerIcons[selectedProviderData?.id || ''] ? (
            <img 
              src={providerIcons[selectedProviderData?.id || '']} 
              alt={selectedProviderData?.name || ''}
              className="h-8 w-8 object-contain"
            />
          ) : (
            <span className="text-xl">🔌</span>
          )}
        </div>
        <div>
          <span className="font-medium">{selectedProviderData ? getProviderName(selectedProviderData) : ''}</span>
          <p className="text-xs text-muted-foreground">
            {selectedProviderData ? getProviderDescription(selectedProviderData) : ''}
          </p>
        </div>
      </div>

      <div className="border-t pt-4">
        <h4 className="text-sm font-medium mb-3">{t('providers.credentials')}</h4>
        
        {supportsOAuth ? (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="manual">{t('providers.manualInput')}</TabsTrigger>
              <TabsTrigger value="oauth">{t('providers.oauthLogin')}</TabsTrigger>
            </TabsList>

            <TabsContent value="manual" className="mt-4">
              {renderCredentialFields()}
            </TabsContent>

            <TabsContent value="oauth" className="mt-4">
              <div className="flex flex-col items-center justify-center py-6 space-y-4">
                <div className="text-center">
                  <p className="text-sm text-muted-foreground mb-4">
                    {t('providers.clickToOpenOAuth')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('providers.oauthAutoCapture')}
                  </p>
                </div>
                <Button 
                  onClick={handleOpenOAuthBrowser}
                  disabled={isOAuthLoading}
                >
                  {isOAuthLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {oauthStatus || t('providers.loggingIn')}
                    </>
                  ) : (
                    <>
                      <ExternalLink className="mr-2 h-4 w-4" />
                      {t('providers.openOAuthLogin')}
                    </>
                  )}
                </Button>
                {oauthStatus && !isOAuthLoading && (
                  <p className={`text-sm ${validationResult.valid ? 'text-green-600' : 'text-red-500'}`}>
                    {oauthStatus}
                  </p>
                )}
              </div>
            </TabsContent>
          </Tabs>
        ) : (
          renderCredentialFields()
        )}

        {validationResult.error && (
          <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 p-3 rounded-lg mt-4">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{validationResult.error}</span>
          </div>
        )}

        {validationResult.valid && validationResult.userInfo && (
          <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-3 rounded-lg mt-4">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
            <div>
              <span className="font-medium">{t('providers.validationSuccess')}</span>
              {validationResult.userInfo.quota !== undefined && (
                <span className="ml-2">
                  {t('providers.quota')}: {validationResult.userInfo.used || 0} / {validationResult.userInfo.quota}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {step === 1 ? t('providers.addProvider') : t('providers.addAccount')}
          </DialogTitle>
          <DialogDescription>
            {step === 1 
              ? t('providers.selectProvider')
              : t('providers.credentials')
            }
          </DialogDescription>
        </DialogHeader>

        {step === 1 ? renderStep1() : renderStep2()}

        <DialogFooter>
          {step === 1 ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={handleNextStep}
                disabled={!selectedProvider}
              >
                {t('common.next')}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={handleBackStep}>
                <ArrowLeft className="mr-2 h-4 w-4" />
                {t('common.previous')}
              </Button>
              {onValidateToken && (
                <Button
                  variant="outline"
                  onClick={handleValidate}
                  disabled={isValidating || isSubmitting}
                >
                  {isValidating ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('oauth.validating')}
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      {t('providers.validateCredentials')}
                    </>
                  )}
                </Button>
              )}
              <Button
                onClick={handleSubmit}
                disabled={isValidating || isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t('providers.processing')}
                  </>
                ) : (
                  t('providers.addAccount')
                )}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default AddProviderDialog
