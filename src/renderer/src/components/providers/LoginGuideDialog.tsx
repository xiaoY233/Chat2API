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
import { ScrollArea } from '@/components/ui/scroll-area'
import { ExternalLink, Loader2, Check, Copy, AlertCircle } from 'lucide-react'
import type { BuiltinProviderConfig } from '@/types/electron'
import deepseekIcon from '@/assets/providers/deepseek.svg'
import glmIcon from '@/assets/providers/glm.svg'
import kimiIcon from '@/assets/providers/kimi.svg'
import minimaxIcon from '@/assets/providers/minimax.svg'
import qwenIcon from '@/assets/providers/qwen.svg'
import zaiIcon from '@/assets/providers/zai.svg'

const providerIcons: Record<string, string> = {
  deepseek: deepseekIcon,
  glm: glmIcon,
  kimi: kimiIcon,
  minimax: minimaxIcon,
  qwen: qwenIcon,
  'qwen-ai': qwenIcon,
  zai: zaiIcon,
}

interface LoginGuideDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: BuiltinProviderConfig | null
  onSuccess: (credentials: Record<string, string>) => Promise<void>
}

export function LoginGuideDialog({
  open,
  onOpenChange,
  provider,
  onSuccess,
}: LoginGuideDialogProps) {
  const { t } = useTranslation()
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [isValidating, setIsValidating] = useState(false)
  const [success, setSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerGuides: Record<string, {
    loginUrl: string
    steps: string[]
  }> = {
    deepseek: {
      loginUrl: 'https://chat.deepseek.com',
      steps: [
        t('loginGuide.openWebsite', { provider: 'DeepSeek' }),
        t('oauth.step1').replace('Login to your account', 'Login to your account'),
        t('oauth.step2'),
        t('oauth.step3'),
        'In Local Storage → chat.deepseek.com',
        'Find userToken field and copy its value',
        t('loginGuide.paste'),
      ],
    },
    qwen: {
      loginUrl: 'https://www.qianwen.com',
      steps: [
        t('loginGuide.openWebsite', { provider: t('qwen.name') }),
        t('oauth.step1'),
        t('oauth.step2'),
        t('oauth.step3'),
        'In Cookies → www.qianwen.com',
        'Find tongyi_sso_ticket and copy its value',
        t('loginGuide.paste'),
      ],
    },
    'qwen-ai': {
      loginUrl: 'https://chat.qwen.ai',
      steps: [
        t('loginGuide.openWebsite', { provider: t('qwen-ai.name') }),
        t('oauth.step1'),
        t('oauth.step2'),
        t('oauth.step3'),
        '1. In Local Storage → chat.qwen.ai',
        '   Find "token" field (JWT format, starts with "eyJ...")',
        '2. In Cookies → chat.qwen.ai (Optional but recommended)',
        '   Copy all cookies or key cookies: cnaui, aui, sca, cna',
        t('loginGuide.paste'),
      ],
    },
    glm: {
      loginUrl: 'https://chatglm.cn',
      steps: [
        t('loginGuide.openWebsite', { provider: t('glm.name') }),
        t('oauth.step1'),
        t('oauth.step2'),
        t('oauth.step3'),
        'In Cookies → chatglm.cn',
        'Find chatglm_refresh_token field',
        t('loginGuide.paste'),
      ],
    },
    kimi: {
      loginUrl: 'https://www.kimi.com',
      steps: [
        t('loginGuide.openWebsite', { provider: 'Kimi' }),
        t('oauth.step1'),
        t('oauth.step2'),
        'Open DevTools → Application → Cookies',
        'Find kimi-auth cookie',
        'Copy the JWT token value',
        t('loginGuide.paste'),
      ],
    },
    minimax: {
      loginUrl: 'https://agent.minimaxi.com',
      steps: [
        t('loginGuide.openWebsite', { provider: t('minimax.name') }),
        t('oauth.step1'),
        t('oauth.step2'),
        t('oauth.step3'),
        'In Local Storage → agent.minimaxi.com',
        'Find user_id and token fields',
        t('loginGuide.paste'),
      ],
    },
    zai: {
      loginUrl: 'https://chat.z.ai',
      steps: [
        t('loginGuide.openWebsite', { provider: t('zai.name') }),
        t('oauth.step1'),
        t('oauth.step2'),
        t('oauth.step3'),
        'In Cookies → chat.z.ai',
        'Find token field (starts with "eyJ...")',
        t('loginGuide.paste'),
      ],
    },
  }

  const guide = provider ? providerGuides[provider.id] : null

  const getProviderName = () => {
    if (provider?.id) {
      return t(`${provider.id}.name`, { defaultValue: provider.name })
    }
    return provider?.name || ''
  }

  useEffect(() => {
    if (!open) {
      setCredentials({})
      setIsValidating(false)
      setSuccess(false)
      setError(null)
    } else if (provider?.credentialFields) {
      const initialCredentials: Record<string, string> = {}
      provider.credentialFields.forEach(field => {
        initialCredentials[field.name] = ''
      })
      setCredentials(initialCredentials)
    }
  }, [open, provider])

  const handleOpenBrowser = async () => {
    if (guide?.loginUrl) {
      try {
        await window.electronAPI?.app.openExternal(guide.loginUrl)
      } catch (err) {
        console.error('Failed to open browser:', err)
        setError(t('loginGuide.openBrowserFailedDesc', { url: guide.loginUrl }))
      }
    }
  }

  const handlePaste = async (fieldName: string) => {
    try {
      const text = await navigator.clipboard.readText()
      setCredentials(prev => ({ ...prev, [fieldName]: text }))
      setError(null)
    } catch (err) {
      console.error('Paste failed:', err)
      setError(t('loginGuide.pasteFailedDesc'))
    }
  }

  const handleCredentialChange = (fieldName: string, value: string) => {
    setCredentials(prev => ({ ...prev, [fieldName]: value }))
    setError(null)
  }

  const handleConfirm = async () => {
    if (!provider) return
    
    const allFilled = provider.credentialFields?.every(
      field => !field.required || credentials[field.name]?.trim()
    )
    if (!allFilled) {
      setError(t('loginGuide.fillRequiredFields'))
      return
    }
    
    setIsValidating(true)
    setError(null)
    try {
      await onSuccess(credentials)
      setSuccess(true)
    } catch (err) {
      console.error('Validation failed:', err)
      const errorMessage = err instanceof Error ? err.message : t('loginGuide.addFailed')
      setError(errorMessage)
    } finally {
      setIsValidating(false)
    }
  }

  if (!provider || !guide) {
    return null
  }

  if (success) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <div className="flex items-center justify-center py-4">
              <div className="h-16 w-16 rounded-full bg-green-500/20 flex items-center justify-center">
                <Check className="h-8 w-8 text-green-500" />
              </div>
            </div>
            <DialogTitle className="text-center">{t('loginGuide.addSuccess')}</DialogTitle>
            <DialogDescription className="text-center">
              {t('loginGuide.accountAddedDesc', { provider: getProviderName() })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>
              {t('loginGuide.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center overflow-hidden">
              {providerIcons[provider.id] ? (
                <img 
                  src={providerIcons[provider.id]} 
                  alt={provider.name}
                  className="h-10 w-10 object-contain"
                />
              ) : (
                <span className="text-2xl">🔌</span>
              )}
            </div>
            <div>
              <DialogTitle>{t('loginGuide.getToken', { provider: getProviderName() })}</DialogTitle>
              <DialogDescription>
                {t('loginGuide.getTokenDesc')}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          <div className="p-4 rounded-lg bg-muted/50">
            <p className="text-sm font-medium mb-2">{t('loginGuide.steps')}</p>
            <ScrollArea className="max-h-[200px]">
              <ol className="text-sm text-muted-foreground space-y-2">
                {guide.steps.map((step, index) => (
                  <li key={index} className="flex items-start gap-2">
                    <span className="flex-shrink-0 w-5 h-5 rounded-full bg-primary/20 text-primary text-xs flex items-center justify-center">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
            </ScrollArea>
          </div>

          <Button
            variant="outline"
            className="w-full"
            onClick={handleOpenBrowser}
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            {t('loginGuide.openWebsite', { provider: getProviderName() })}
          </Button>

          <div className="space-y-3">
            {provider.credentialFields?.map((field) => (
              <div key={field.name} className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">
                    {field.label}
                    {field.required && <span className="text-destructive ml-1">*</span>}
                  </label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handlePaste(field.name)}
                    className="h-7 text-xs"
                  >
                    <Copy className="mr-1 h-3 w-3" />
                    {t('loginGuide.paste')}
                  </Button>
                </div>
                <Input
                  type={field.type === 'password' ? 'password' : 'text'}
                  placeholder={field.placeholder}
                  value={credentials[field.name] || ''}
                  onChange={(e) => handleCredentialChange(field.name, e.target.value)}
                />
                {field.helpText && (
                  <p className="text-xs text-muted-foreground">{field.helpText}</p>
                )}
              </div>
            ))}
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isValidating}
          >
            {isValidating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('oauth.validating')}
              </>
            ) : (
              <>
                {t('loginGuide.confirmAdd')}
                <Check className="ml-2 h-4 w-4" />
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default LoginGuideDialog
