/**
 * Add Account Dialog Component
 * Supports OAuth login and manual input methods
 */

import { useState, useEffect, useRef } from 'react'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { 
  ExternalLink, 
  User, 
  AlertCircle,
  Loader2,
  CheckCircle2,
  Eye,
  EyeOff,
  Copy,
  Check
} from 'lucide-react'
import type { Provider, CredentialField, Account, BuiltinProviderConfig, ProviderVendor } from '@/types/electron'

/**
 * Map OAuth credentials to provider credential field names
 * OAuth returns credentials with keys like 'chatglm_refresh_token', but providers expect 'refresh_token'
 * DeepSeek stores token as JSON: {"value":"..."}
 */
function mapOAuthCredentials(providerId: string | undefined, credentials: Record<string, string>): Record<string, string> {
  if (!providerId) return credentials

  const credentialKeyMap: Record<string, string> = {
    'glm': 'chatglm_refresh_token',
    'deepseek': 'userToken',
    'qwen': 'tongyi_sso_ticket',
    'zai': 'tongyi_sso_ticket',
    'perplexity': '__Secure-next-auth.session-token',
    'mimo': 'serviceToken',
  }

  const providerFieldNames: Record<string, string> = {
    'glm': 'refresh_token',
    'deepseek': 'token',
    'qwen': 'ticket',
    'zai': 'ticket',
    'perplexity': 'sessionToken',
    'mimo': 'service_token',
  }

  if (providerId === 'qwen-ai') {
    return {
      token: credentials.token || '',
      ...(credentials.cookies ? { cookies: credentials.cookies } : {}),
      ...(credentials.baxiaUidToken ? { baxiaUidToken: credentials.baxiaUidToken } : {}),
      ...(credentials.baxiaUa ? { baxiaUa: credentials.baxiaUa } : {}),
      ...(credentials.baxiaVersion ? { baxiaVersion: credentials.baxiaVersion } : {}),
      ...(credentials.x5secdata ? { x5secdata: credentials.x5secdata } : {}),
      ...(credentials.x5sectag ? { x5sectag: credentials.x5sectag } : {}),
    }
  }

  if (providerId === 'kimi') {
    const refreshToken = credentials.refreshToken || credentials.refresh_token || ''
    const token = credentials.accessToken
      || credentials.access_token
      || credentials.token
      || credentials.kimiAuth
      || credentials['kimi-auth']
      || refreshToken
      || ''
    const trafficId = credentials.trafficId
      || credentials.traffic_id
      || credentials.userId
      || credentials.user_id
      || credentials.mshUserId
      || credentials.msh_user_id
      || ''
    const deviceId = credentials.deviceId || credentials.device_id || credentials.webId || credentials.web_id || ''
    const sessionId = credentials.sessionId || credentials.session_id || credentials.ssid || ''
    return {
      token,
      ...(refreshToken ? { refreshToken } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(trafficId ? { trafficId } : {}),
    }
  }

  const oauthKey = credentialKeyMap[providerId]
  if (oauthKey && credentials[oauthKey]) {
    const fieldName = providerFieldNames[providerId]
    if (fieldName) {
      // Handle JSON-wrapped tokens (DeepSeek stores token as {"value":"..."})
      let tokenValue = credentials[oauthKey]
      if (providerId === 'deepseek' && tokenValue && tokenValue.startsWith('{') && tokenValue.endsWith('}')) {
        try {
          const parsed = JSON.parse(tokenValue)
          if (parsed.value) {
            tokenValue = parsed.value
          }
        } catch (e) {
          console.error('[AddAccountDialog] Error parsing JSON token:', e)
        }
      }
      return { [fieldName]: tokenValue }
    }
  }

  // For Perplexity, if we have the secure token, map it
  if (providerId === 'perplexity' && credentials['__Secure-next-auth.session-token']) {
    return { sessionToken: credentials['__Secure-next-auth.session-token'] }
  }
  if (providerId === 'perplexity' && credentials['next-auth.session-token']) {
    return { sessionToken: credentials['next-auth.session-token'] }
  }

  // For Mimo, map all three tokens
  if (providerId === 'mimo') {
    const result: Record<string, string> = {}
    // OAuth already returns credentials in correct format (service_token, user_id, ph_token)
    // Check for final format first
    if (credentials['service_token']) {
      result['service_token'] = credentials['service_token']
    } else if (credentials['serviceToken']) {
      result['service_token'] = credentials['serviceToken']
    }
    if (credentials['user_id']) {
      result['user_id'] = credentials['user_id']
    } else if (credentials['userId']) {
      result['user_id'] = credentials['userId']
    }
    if (credentials['ph_token']) {
      result['ph_token'] = credentials['ph_token']
    } else if (credentials['xiaomichatbot_ph']) {
      result['ph_token'] = credentials['xiaomichatbot_ph']
    }
    return result
  }

  return credentials
}

function selectVisibleTextArea(textarea: HTMLTextAreaElement | null): boolean {
  if (!textarea) return false

  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)
  return true
}

async function copyTextToClipboard(text: string, visibleTextarea?: HTMLTextAreaElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch (error) {
    console.warn('Clipboard API copy failed:', error)
  }

  if (selectVisibleTextArea(visibleTextarea || null)) {
    try {
      return document.execCommand('copy')
    } catch (error) {
      console.warn('Visible textarea copy failed:', error)
      return false
    }
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'readonly')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  const copied = document.execCommand('copy')
  document.body.removeChild(textarea)

  return copied
}

interface AddAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider: Provider | null
  onAddAccount: (data: {
    name: string
    email?: string
    credentials: Record<string, string>
    dailyLimit?: number
  }) => Promise<void>
  onValidateToken: (providerId: string, credentials: Record<string, string>) => Promise<{
    valid: boolean
    error?: string
    credentials?: Record<string, string>
    userInfo?: {
      name?: string
      email?: string
      quota?: number
      used?: number
    }
  }>
  editingAccount?: Account | null
  onUpdateAccount?: (id: string, updates: Partial<Account>) => Promise<void>
}

export function AddAccountDialog({
  open,
  onOpenChange,
  provider,
  onAddAccount,
  onValidateToken,
  editingAccount,
  onUpdateAccount,
}: AddAccountDialogProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<string>('manual')
  const [name, setName] = useState('')
  const [dailyLimit, setDailyLimit] = useState<string>('')
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [isValidating, setIsValidating] = useState(false)
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
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isOAuthLoading, setIsOAuthLoading] = useState(false)
  const [oauthStatus, setOAuthStatus] = useState<string>('')
  const [browserImportSessionId, setBrowserImportSessionId] = useState<string>('')
  const [browserImportScript, setBrowserImportScript] = useState<string>('')
  const [browserImportPayload, setBrowserImportPayload] = useState<string>('')
  const [isBrowserImportWaiting, setIsBrowserImportWaiting] = useState(false)
  const [browserImportCopied, setBrowserImportCopied] = useState(false)
  const browserImportScriptRef = useRef<HTMLTextAreaElement | null>(null)

  const isEditing = !!editingAccount
  const builtinProvider = provider as BuiltinProviderConfig | null
  const credentialFields: CredentialField[] = builtinProvider?.credentialFields || getDefaultCredentialFields(provider?.authType, t)
  const oauthRefreshCredentialFields = provider?.id === 'qwen-ai'
    ? credentialFields.filter(field => ['email', 'password'].includes(field.name))
    : []
  const supportsOAuth = provider && ['deepseek', 'glm', 'kimi', 'mimo', 'minimax', 'qwen', 'qwen-ai', 'zai', 'perplexity'].includes(provider.id)
  const isDockerWebAdmin = !!window.__CHAT2API_WEB_ADMIN__
  const supportsBrowserImport = isDockerWebAdmin && provider && ['qwen', 'qwen-ai', 'kimi'].includes(provider.id)

  useEffect(() => {
    if (open) {
      if (editingAccount) {
        setName(editingAccount.name)
        setDailyLimit(editingAccount.dailyLimit?.toString() || '')
        setCredentials(editingAccount.credentials || {})
        setActiveTab('manual')
      } else {
        resetForm()
      }
    }
  }, [open, editingAccount])

  const resetForm = () => {
    setName('')
    setDailyLimit('')
    setCredentials({})
    setValidationResult({})
    setActiveTab('manual')
    setIsOAuthLoading(false)
    setOAuthStatus('')
    setBrowserImportSessionId('')
    setBrowserImportScript('')
    setBrowserImportPayload('')
    setIsBrowserImportWaiting(false)
    setBrowserImportCopied(false)
  }

  const handleCredentialChange = (fieldName: string, value: string) => {
    setCredentials(prev => ({
      ...prev,
      [fieldName]: value,
    }))
    setValidationResult({})
  }

  const handleValidate = async () => {
    if (!provider) return

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
      const result = await onValidateToken(provider.id, credentials)
      if (result.valid && result.credentials) {
        setCredentials(prev => ({
          ...prev,
          ...result.credentials,
        }))
      }
      setValidationResult(result)

      if (result.valid && result.userInfo) {
        if (!name && result.userInfo.name) {
          setName(result.userInfo.name)
        }
      }
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
    if (!name.trim()) {
      setValidationResult({
        valid: false,
        error: t('providers.enterAccountName'),
      })
      return
    }

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
      // For MiniMax, ensure realUserID is passed correctly
      let finalCredentials = { ...credentials }
      if (provider?.id === 'minimax' && credentials.realUserID && credentials.realUserID.trim()) {
        // realUserID is provided separately, keep both fields
        console.log('[AddAccountDialog] MiniMax realUserID provided:', credentials.realUserID)
      }

      const accountEmail = provider?.id === 'qwen-ai'
        ? finalCredentials.email?.trim() || undefined
        : undefined

      const data = {
        name: name.trim(),
        email: accountEmail,
        credentials: finalCredentials,
        dailyLimit: dailyLimit ? parseInt(dailyLimit, 10) : undefined,
      }

      if (isEditing && editingAccount && onUpdateAccount) {
        await onUpdateAccount(editingAccount.id, data)
      } else {
        await onAddAccount(data)
      }

      onOpenChange(false)
      resetForm()
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
    if (!provider) return
    
    setIsOAuthLoading(true)
    setOAuthStatus(t('providers.openingLoginWindow'))
    
    try {
      const result = await window.electronAPI?.oauth.startInAppLogin(
        provider.id,
        provider.id as ProviderVendor
      )
      
      if (result?.success && result.credentials) {
        // Map OAuth credentials to provider credential field names
        const mappedCredentials = mapOAuthCredentials(provider?.id, result.credentials)
        setCredentials(prev => ({
          ...prev,
          ...mappedCredentials,
        }))
        setOAuthStatus(t('providers.loginSuccess'))
        
        if (result.accountInfo?.name) {
          setName(result.accountInfo.name)
        }
        
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

  const startBrowserImport = async () => {
    if (!provider || !window.electronAPI?.browserImport) return

    setIsBrowserImportWaiting(true)
    setBrowserImportCopied(false)
    setBrowserImportPayload('')
    setOAuthStatus('')
    setValidationResult({})

    try {
      const session = await window.electronAPI.browserImport.createSession(provider.id)
      const script = await window.electronAPI.browserImport.buildImportScript(session.id)
      setBrowserImportSessionId(session.id)
      setBrowserImportScript(script)
      setOAuthStatus(t('providers.browserImportReady'))
    } catch (error) {
      setIsBrowserImportWaiting(false)
      setOAuthStatus(error instanceof Error ? error.message : t('providers.browserImportCreateFailed'))
    }
  }

  const copyBrowserImportScript = async () => {
    if (!browserImportScript) return

    try {
      const copied = await copyTextToClipboard(browserImportScript, browserImportScriptRef.current)
      if (copied) {
        setBrowserImportCopied(true)
        window.setTimeout(() => setBrowserImportCopied(false), 1500)
      } else {
        selectVisibleTextArea(browserImportScriptRef.current)
        setOAuthStatus(t('providers.browserImportCopyManual'))
      }
    } catch (error) {
      console.warn('Failed to copy browser import script:', error)
      selectVisibleTextArea(browserImportScriptRef.current)
      setOAuthStatus(t('providers.browserImportCopyManual'))
    }
  }

  const handleBrowserImportSessionResult = (session: {
    id?: string
    status: 'pending' | 'success' | 'error' | 'expired'
    credentials?: Record<string, string>
    error?: string
  }): boolean => {
    if (session.status === 'success' && session.credentials) {
      const mappedCredentials = mapOAuthCredentials(provider?.id, session.credentials)
      setCredentials(prev => ({
        ...prev,
        ...mappedCredentials,
      }))
      setValidationResult({ valid: true })
      setOAuthStatus(t('providers.browserImportSuccess'))
      setIsBrowserImportWaiting(false)
      return true
    }

    if (session.status === 'error' || session.status === 'expired') {
      setValidationResult({
        valid: false,
        error: session.error || t('providers.browserImportFailed'),
      })
      setOAuthStatus(session.error || t('providers.browserImportFailed'))
      setIsBrowserImportWaiting(false)
      return true
    }

    return false
  }

  const applyBrowserImportPayload = async () => {
    if (!browserImportPayload.trim() || !window.electronAPI?.browserImport) return

    try {
      const session = await window.electronAPI.browserImport.applyImportPayload(browserImportPayload)
      setBrowserImportSessionId(session.id)
      handleBrowserImportSessionResult(session)
    } catch (error) {
      const message = error instanceof Error ? error.message : t('providers.browserImportFailed')
      setValidationResult({
        valid: false,
        error: message,
      })
      setOAuthStatus(message)
    }
  }

  const openProviderLoginPage = async () => {
    if (!provider) return
    const loginUrls: Record<string, string> = {
      'qwen-ai': 'https://chat.qwen.ai',
      qwen: 'https://www.qianwen.com',
      kimi: 'https://www.kimi.com',
    }
    await window.electronAPI?.app.openExternal(loginUrls[provider.id] || provider.apiEndpoint)
  }

  useEffect(() => {
    if (!browserImportSessionId || !isBrowserImportWaiting || !window.electronAPI?.browserImport) return

    let cancelled = false
    const timer = window.setInterval(async () => {
      try {
        const session = await window.electronAPI.browserImport.getSession(browserImportSessionId)
        if (cancelled || !session) return

        if (handleBrowserImportSessionResult(session)) {
          window.clearInterval(timer)
        }
      } catch (error) {
        if (!cancelled) {
          setOAuthStatus(error instanceof Error ? error.message : t('providers.browserImportReadFailed'))
        }
      }
    }, 1500)

    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [browserImportSessionId, isBrowserImportWaiting, provider?.id])

  if (!provider) return null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              {isEditing ? t('providers.editAccount') : t('providers.addAccount')}
            </DialogTitle>
            <DialogDescription>
              {t('providers.manageAllAccounts')} - {provider.name}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('providers.accountName')} *</Label>
              <Input
                id="name"
                placeholder={t('providers.accountNamePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dailyLimit">{t('providers.dailyLimitOptional')}</Label>
              <Input
                id="dailyLimit"
                type="number"
                placeholder={t('providers.dailyLimitPlaceholder')}
                value={dailyLimit}
                onChange={(e) => setDailyLimit(e.target.value)}
              />
            </div>

            {supportsOAuth && !isEditing && (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="manual">{t('providers.manualInput')}</TabsTrigger>
                  <TabsTrigger value="oauth">{t('providers.oauthLogin')}</TabsTrigger>
                </TabsList>

                <TabsContent value="manual" className="mt-4">
                  <CredentialFieldsForm
                    fields={credentialFields}
                    credentials={credentials}
                    onChange={handleCredentialChange}
                    t={t}
                    providerId={provider?.id}
                  />
                </TabsContent>

                <TabsContent value="oauth" className="mt-4">
                  {supportsBrowserImport ? (
                    <div className="space-y-4">
                      <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                        <p className="font-medium text-foreground">{t('providers.browserImportTitle')}</p>
                        <p className="mt-1">{t('providers.browserImportDesc')}</p>
                      </div>
                      {oauthRefreshCredentialFields.length > 0 && (
                        <div className="rounded-lg border p-3">
                          <CredentialFieldsForm
                            fields={oauthRefreshCredentialFields}
                            credentials={credentials}
                            onChange={handleCredentialChange}
                            t={t}
                            providerId={provider?.id}
                          />
                        </div>
                      )}
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="outline" onClick={openProviderLoginPage}>
                          <ExternalLink className="mr-2 h-4 w-4" />
                          {t('providers.openProviderWebsite')}
                        </Button>
                        <Button type="button" onClick={startBrowserImport} disabled={isBrowserImportWaiting && !!browserImportScript}>
                          {isBrowserImportWaiting && !browserImportScript ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Copy className="mr-2 h-4 w-4" />
                          )}
                          {browserImportScript ? t('providers.regenerateImportScript') : t('providers.generateImportScript')}
                        </Button>
                      </div>
                      {browserImportScript && (
                        <div className="space-y-2">
                          <Label>{t('providers.importScript')}</Label>
                          <textarea
                            ref={browserImportScriptRef}
                            readOnly
                            value={browserImportScript}
                            className="h-32 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs"
                          />
                          <Button type="button" variant="outline" onClick={copyBrowserImportScript}>
                            {browserImportCopied ? (
                              <Check className="mr-2 h-4 w-4" />
                            ) : (
                              <Copy className="mr-2 h-4 w-4" />
                            )}
                            {browserImportCopied ? t('common.copied') : t('providers.copyImportScript')}
                          </Button>
                          <div className="space-y-2 rounded-md border p-3">
                            <Label>{t('providers.browserImportPayload')}</Label>
                            <textarea
                              value={browserImportPayload}
                              onChange={(event) => setBrowserImportPayload(event.target.value)}
                              placeholder={t('providers.browserImportPayloadPlaceholder')}
                              className="h-24 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs"
                            />
                            <div className="flex flex-wrap items-center gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                onClick={applyBrowserImportPayload}
                                disabled={!browserImportPayload.trim()}
                              >
                                <CheckCircle2 className="mr-2 h-4 w-4" />
                                {t('providers.applyImportPayload')}
                              </Button>
                              <p className="text-xs text-muted-foreground">
                                {t('providers.browserImportPayloadHelp')}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                      {isBrowserImportWaiting && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2 className="h-4 w-4 animate-spin" />
                          <span>{t('providers.waitingBrowserImport')}</span>
                        </div>
                      )}
                      {oauthStatus && (
                        <p className={`text-sm ${validationResult.valid ? 'text-green-600' : 'text-muted-foreground'}`}>
                          {oauthStatus}
                        </p>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-6 space-y-4">
                      {oauthRefreshCredentialFields.length > 0 && (
                        <div className="w-full rounded-lg border p-3">
                          <CredentialFieldsForm
                            fields={oauthRefreshCredentialFields}
                            credentials={credentials}
                            onChange={handleCredentialChange}
                            t={t}
                            providerId={provider?.id}
                          />
                        </div>
                      )}
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
                  )}
                </TabsContent>
              </Tabs>
            )}

            {(!supportsOAuth || isEditing) && (
              <CredentialFieldsForm
                fields={credentialFields}
                credentials={credentials}
                onChange={handleCredentialChange}
                t={t}
                providerId={provider?.id}
              />
            )}

            {validationResult.error && (
              <div className="flex items-center gap-2 text-sm text-red-500 bg-red-50 p-3 rounded-lg">
                <AlertCircle className="h-4 w-4 flex-shrink-0" />
                <span>{validationResult.error}</span>
              </div>
            )}

            {validationResult.valid && validationResult.userInfo && (
              <div className="flex items-center gap-2 text-sm text-green-600 bg-green-50 p-3 rounded-lg">
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

          <DialogFooter className="mt-6">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              {t('common.cancel')}
            </Button>
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
            <Button
              onClick={handleSubmit}
              disabled={isSubmitting || isValidating}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('providers.saving')}
                </>
              ) : (
                isEditing ? t('providers.saveChanges') : t('providers.addAccount')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

interface CredentialFieldsFormProps {
  fields: CredentialField[]
  credentials: Record<string, string>
  onChange: (fieldName: string, value: string) => void
  t: (key: string) => string
  providerId?: string
}

function CredentialFieldsForm({ fields, credentials, onChange, t, providerId }: CredentialFieldsFormProps) {
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({})
  const [copiedFields, setCopiedFields] = useState<Record<string, boolean>>({})

  const toggleFieldVisibility = (fieldName: string) => {
    setVisibleFields(prev => ({
      ...prev,
      [fieldName]: !prev[fieldName]
    }))
  }

  const copyToClipboard = async (fieldName: string, value: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopiedFields(prev => ({ ...prev, [fieldName]: true }))
      setTimeout(() => {
        setCopiedFields(prev => ({ ...prev, [fieldName]: false }))
      }, 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const getFieldTranslation = (field: CredentialField) => {
    if (!providerId) return { label: field.label, placeholder: field.placeholder, helpText: field.helpText }

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
        email: {
          label: t('qwen-ai.email'),
          placeholder: t('qwen-ai.emailPlaceholder'),
          helpText: t('qwen-ai.emailHelp'),
        },
        password: {
          label: t('qwen-ai.password'),
          placeholder: t('qwen-ai.passwordPlaceholder'),
          helpText: t('qwen-ai.passwordHelp'),
        },
      },
      zai: {
        token: {
          label: t('zai.token'),
          placeholder: t('zai.tokenPlaceholder'),
          helpText: t('zai.tokenHelp'),
        },
      },
      mimo: {
        service_token: {
          label: t('mimo.serviceToken'),
          placeholder: t('mimo.serviceTokenPlaceholder'),
          helpText: t('mimo.serviceTokenHelp'),
        },
        user_id: {
          label: t('mimo.userId'),
          placeholder: t('mimo.userIdPlaceholder'),
          helpText: t('mimo.userIdHelp'),
        },
        ph_token: {
          label: t('mimo.phToken'),
          placeholder: t('mimo.phTokenPlaceholder'),
          helpText: t('mimo.phTokenHelp'),
        },
      },
      perplexity: {
        sessionToken: {
          label: t('perplexity.sessionToken'),
          placeholder: t('perplexity.sessionTokenPlaceholder'),
          helpText: t('perplexity.sessionTokenHelp'),
        },
      },
    }

    const providerTranslations = translations[providerId]
    if (providerTranslations && providerTranslations[field.name]) {
      return providerTranslations[field.name]
    }

    return { label: field.label, placeholder: field.placeholder, helpText: field.helpText }
  }

  return (
    <div className="space-y-4">
      {fields.map((field) => {
        const translated = getFieldTranslation(field)
        const isPasswordField = field.type === 'password'
        const isVisible = visibleFields[field.name]
        const isCopied = copiedFields[field.name]
        const fieldValue = credentials[field.name] || ''
        
        return (
          <div key={field.name} className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor={field.name}>{translated.label}</Label>
              {field.required && (
                <Badge variant="outline" className="text-xs">{t('providers.required')}</Badge>
              )}
            </div>
            {field.type === 'textarea' ? (
              <div className="relative">
                <textarea
                  id={field.name}
                  className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 pr-20"
                  placeholder={translated.placeholder}
                  value={fieldValue}
                  onChange={(e) => onChange(field.name, e.target.value)}
                />
                <div className="absolute right-1 top-1 flex gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => copyToClipboard(field.name, fieldValue)}
                    disabled={!fieldValue}
                  >
                    {isCopied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => toggleFieldVisibility(field.name)}
                  >
                    {isVisible ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
            ) : isPasswordField ? (
              <div className="relative">
                <Input
                  id={field.name}
                  type={isVisible ? 'text' : 'password'}
                  placeholder={translated.placeholder}
                  value={fieldValue}
                  onChange={(e) => onChange(field.name, e.target.value)}
                  className="pr-20"
                />
                <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-0.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => copyToClipboard(field.name, fieldValue)}
                    disabled={!fieldValue}
                  >
                    {isCopied ? (
                      <Check className="h-4 w-4 text-green-500" />
                    ) : (
                      <Copy className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => toggleFieldVisibility(field.name)}
                  >
                    {isVisible ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
            ) : (
              <Input
                id={field.name}
                type={field.type}
                placeholder={translated.placeholder}
                value={fieldValue}
                onChange={(e) => onChange(field.name, e.target.value)}
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

function getDefaultCredentialFields(authType?: string, t?: (key: string) => string): CredentialField[] {
  const fieldConfigs: Record<string, CredentialField[]> = {
    token: [
      {
        name: 'token',
        label: 'API Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterApiToken') : 'Enter API Token',
      },
    ],
    cookie: [
      {
        name: 'cookie',
        label: 'Cookie',
        type: 'textarea',
        required: true,
        placeholder: t ? t('providers.enterCookieString') : 'Enter complete Cookie string',
      },
    ],
    oauth: [
      {
        name: 'access_token',
        label: 'Access Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterOAuthAccessToken') : 'Enter OAuth Access Token',
      },
    ],
    refresh_token: [
      {
        name: 'refresh_token',
        label: 'Refresh Token',
        type: 'password',
        required: true,
        placeholder: t ? t('providers.enterRefreshToken') : 'Enter Refresh Token',
      },
    ],
    jwt: [
      {
        name: 'jwt',
        label: 'JWT Token',
        type: 'textarea',
        required: true,
        placeholder: t ? t('providers.enterJwtToken') : 'Enter JWT Token (starts with eyJ)',
      },
    ],
  }

  return fieldConfigs[authType || 'token'] || fieldConfigs.token
}

export default AddAccountDialog
