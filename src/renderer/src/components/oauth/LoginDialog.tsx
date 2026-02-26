/**
 * OAuth Login Dialog Component
 * Provides unified OAuth login interface for multiple providers
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TokenInput } from './TokenInput'
import { OAuthProgress, OAuthProgressStatus } from './OAuthProgress'
import { ExternalLink, AlertCircle } from 'lucide-react'

type ProviderType = 'deepseek' | 'glm' | 'kimi' | 'minimax' | 'qwen' | 'zai'

interface OAuthLoginResult {
  success: boolean
  credentials?: Record<string, string>
  error?: string
}

interface ManualTokenConfig {
  providerType: ProviderType
  tokenType: string
  labelKey: string
  placeholderKey: string
  descriptionKey: string
  helpUrl?: string
}

interface ProviderConfig {
  nameKey: string
  loginUrl: string
  manualTokenConfigs: ManualTokenConfig[]
}

const PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig> = {
  deepseek: {
    nameKey: 'deepseek.name',
    loginUrl: 'https://chat.deepseek.com',
    manualTokenConfigs: [
      {
        providerType: 'deepseek',
        tokenType: 'token',
        labelKey: 'deepseek.userToken',
        placeholderKey: 'deepseek.userTokenPlaceholder',
        descriptionKey: 'deepseek.userTokenHelp',
        helpUrl: 'https://chat.deepseek.com',
      },
    ],
  },
  glm: {
    nameKey: 'glm.name',
    loginUrl: 'https://chatglm.cn',
    manualTokenConfigs: [
      {
        providerType: 'glm',
        tokenType: 'refresh',
        labelKey: 'glm.refreshToken',
        placeholderKey: 'glm.refreshTokenPlaceholder',
        descriptionKey: 'glm.refreshTokenHelp',
        helpUrl: 'https://chatglm.cn',
      },
    ],
  },
  kimi: {
    nameKey: 'kimi.name',
    loginUrl: 'https://www.kimi.com',
    manualTokenConfigs: [
      {
        providerType: 'kimi',
        tokenType: 'jwt',
        labelKey: 'kimi.accessToken',
        placeholderKey: 'kimi.accessTokenPlaceholder',
        descriptionKey: 'kimi.accessTokenHelp',
        helpUrl: 'https://www.kimi.com',
      },
      {
        providerType: 'kimi',
        tokenType: 'refresh',
        labelKey: 'providers.refreshToken',
        placeholderKey: 'providers.enterRefreshToken',
        descriptionKey: 'kimi.accessTokenHelp',
        helpUrl: 'https://kimi.moonshot.cn',
      },
    ],
  },
  minimax: {
    nameKey: 'minimax.name',
    loginUrl: 'https://agent.minimaxi.com',
    manualTokenConfigs: [
      {
        providerType: 'minimax',
        tokenType: 'token',
        labelKey: 'minimax.jwtToken',
        placeholderKey: 'minimax.jwtTokenPlaceholder',
        descriptionKey: 'minimax.jwtTokenHelp',
        helpUrl: 'https://agent.minimaxi.com',
      },
      {
        providerType: 'minimax',
        tokenType: 'realUserID',
        labelKey: 'minimax.realUserID',
        placeholderKey: 'minimax.realUserIDPlaceholder',
        descriptionKey: 'minimax.realUserIDHelp',
        helpUrl: 'https://agent.minimaxi.com',
      },
    ],
  },
  qwen: {
    nameKey: 'qwen.name',
    loginUrl: 'https://tongyi.aliyun.com',
    manualTokenConfigs: [
      {
        providerType: 'qwen',
        tokenType: 'cookie',
        labelKey: 'qwen.ssoTicket',
        placeholderKey: 'qwen.ssoTicketPlaceholder',
        descriptionKey: 'qwen.ssoTicketHelp',
        helpUrl: 'https://tongyi.aliyun.com',
      },
    ],
  },
  zai: {
    nameKey: 'zai.name',
    loginUrl: 'https://z.ai',
    manualTokenConfigs: [
      {
        providerType: 'zai',
        tokenType: 'token',
        labelKey: 'zai.token',
        placeholderKey: 'zai.tokenPlaceholder',
        descriptionKey: 'zai.tokenHelp',
        helpUrl: 'https://z.ai',
      },
    ],
  },
}

export interface LoginDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  providerId: string
  providerType: ProviderType
  providerName?: string
  defaultTab?: 'manual' | 'browser'
  onSuccess?: (credentials: Record<string, string>) => void
  onError?: (error: string) => void
}

export function LoginDialog({
  open,
  onOpenChange,
  providerId,
  providerType,
  providerName,
  defaultTab = 'manual',
  onSuccess,
  onError,
}: LoginDialogProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<string>(defaultTab)
  const [token, setToken] = useState('')
  const [realUserID, setRealUserID] = useState('') // For MiniMax
  const [tokenType, setTokenType] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string>('')
  const [progress, setProgress] = useState<{
    status: OAuthProgressStatus
    message: string
    progress?: number
  }>({
    status: 'idle',
    message: '',
  })

  const config = PROVIDER_CONFIGS[providerType]
  const displayName = providerName || t(config?.nameKey || '') || providerType
  const isMiniMax = providerType === 'minimax'

  useEffect(() => {
    if (config?.manualTokenConfigs.length) {
      setTokenType(config.manualTokenConfigs[0].tokenType)
    }
  }, [config])

  useEffect(() => {
    const unsubscribe = window.electronAPI?.on('oauth:progress', (data: unknown) => {
      const event = data as { status: OAuthProgressStatus; message: string; progress?: number }
      setProgress({
        status: event.status,
        message: event.message,
        progress: event.progress,
      })
    })
    
    return () => {
      unsubscribe?.()
    }
  }, [])

  const resetState = useCallback(() => {
    setToken('')
    setRealUserID('')
    setError('')
    setIsLoading(false)
    setProgress({ status: 'idle', message: '' })
    setActiveTab(defaultTab)
  }, [defaultTab])

  useEffect(() => {
    if (open) {
      resetState()
    }
  }, [open, resetState])

  const handleOpenBrowser = async () => {
    if (!config?.loginUrl) return
    
    try {
      await window.electronAPI?.invoke('app:openExternal', config.loginUrl)
    } catch (err) {
      setError(t('oauth.cannotOpenBrowser'))
    }
  }

  const handleManualSubmit = async () => {
    if (!token.trim()) {
      setError(t('oauth.enterToken'))
      return
    }

    setIsLoading(true)
    setError('')
    setProgress({ status: 'pending', message: t('oauth.validatingToken') })

    try {
      const result = await window.electronAPI?.invoke('oauth:loginWithToken', {
        providerId,
        providerType,
        token,
        realUserID: isMiniMax ? realUserID.trim() : undefined,
      }) as OAuthLoginResult | undefined

      if (result?.success) {
        setProgress({ status: 'success', message: t('oauth.loginSuccess') })
        onSuccess?.(result.credentials || {})
        setTimeout(() => onOpenChange(false), 1500)
      } else {
        const errorMsg = result?.error || t('oauth.loginFailed')
        const translatedError = errorMsg === 'Login timeout' ? t('oauth.loginTimeout') : errorMsg
        setProgress({ status: 'error', message: translatedError })
        setError(translatedError)
        onError?.(translatedError)
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : t('oauth.unknownError')
      setProgress({ status: 'error', message: errorMessage })
      setError(errorMessage)
      onError?.(errorMessage)
    } finally {
      setIsLoading(false)
    }
  }

  const currentTokenConfig = config?.manualTokenConfigs.find(c => c.tokenType === tokenType) || config?.manualTokenConfigs[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {t('oauth.loginTo', { provider: displayName })}
          </DialogTitle>
          <DialogDescription>
            {t('oauth.selectLoginMethod')}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="mt-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="manual">{t('oauth.manualInput')}</TabsTrigger>
            <TabsTrigger value="browser">{t('oauth.browserLogin')}</TabsTrigger>
          </TabsList>

          <TabsContent value="manual" className="mt-4 space-y-4">
            {config?.manualTokenConfigs.length && config.manualTokenConfigs.length > 1 && !isMiniMax && (
              <div className="flex gap-2">
                {config.manualTokenConfigs.map((tc) => (
                  <Button
                    key={tc.tokenType}
                    type="button"
                    variant={tokenType === tc.tokenType ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTokenType(tc.tokenType)}
                  >
                    {t(tc.labelKey)}
                  </Button>
                ))}
              </div>
            )}

            {currentTokenConfig && (
              <TokenInput
                label={t(currentTokenConfig.labelKey)}
                placeholder={t(currentTokenConfig.placeholderKey)}
                description={t(currentTokenConfig.descriptionKey)}
                helpUrl={currentTokenConfig.helpUrl}
                value={token}
                onChange={setToken}
                onSubmit={handleManualSubmit}
                disabled={isLoading}
                error={error}
              />
            )}

            {isMiniMax && (
              <TokenInput
                label={t('minimax.realUserID')}
                placeholder={t('minimax.realUserIDPlaceholder')}
                description={t('minimax.realUserIDHelp')}
                helpUrl="https://agent.minimaxi.com"
                value={realUserID}
                onChange={setRealUserID}
                onSubmit={handleManualSubmit}
                disabled={isLoading}
              />
            )}

            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <AlertCircle className="h-4 w-4" />
              <span>{t('oauth.tokenStoredLocally')}</span>
            </div>
          </TabsContent>

          <TabsContent value="browser" className="mt-4">
            <div className="flex flex-col items-center justify-center space-y-4 py-8">
              <p className="text-center text-sm text-muted-foreground">
                {t('oauth.clickToOpenBrowser')}
              </p>
              
              <Button onClick={handleOpenBrowser} className="gap-2">
                <ExternalLink className="h-4 w-4" />
                {t('oauth.openLoginPage', { provider: displayName })}
              </Button>

              <div className="mt-4 space-y-2 text-center">
                <p className="text-sm font-medium">{t('oauth.getTokenSteps')}</p>
                <ol className="text-xs text-muted-foreground list-decimal list-inside space-y-1">
                  <li>{t('oauth.step1')}</li>
                  <li>{t('oauth.step2')}</li>
                  <li>{t('oauth.step3')}</li>
                  <li>{t('oauth.step4')}</li>
                  <li>{t('oauth.step5')}</li>
                </ol>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {progress.status !== 'idle' && (
          <OAuthProgress
            status={progress.status}
            message={progress.message}
            progress={progress.progress}
            className="border-t pt-4"
          />
        )}

        <DialogFooter className="mt-4">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            {t('common.cancel')}
          </Button>
          {activeTab === 'manual' && (
            <Button
              onClick={handleManualSubmit}
              disabled={isLoading || !token.trim()}
            >
              {isLoading ? t('oauth.validating') : t('oauth.confirmLogin')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default LoginDialog
