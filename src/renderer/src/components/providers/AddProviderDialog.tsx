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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Check, Plus, ArrowRight, Loader2, ExternalLink, AlertCircle, CheckCircle2, ArrowLeft, Info, Eye, EyeOff, Copy } from 'lucide-react'
import type { BuiltinProviderConfig, ProviderVendor } from '@/types/electron'
import { cn } from '@/lib/utils'
import deepseekIcon from '@/assets/providers/deepseek.svg'
import glmIcon from '@/assets/providers/glm.svg'
import kimiIcon from '@/assets/providers/kimi.svg'
import mimoIcon from '@/assets/providers/mimo.svg'
import minimaxIcon from '@/assets/providers/minimax.svg'
import perplexityIcon from '@/assets/providers/perplexity.svg'
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
    credentials?: Record<string, string>
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
  mimo: mimoIcon,
  minimax: minimaxIcon,
  perplexity: perplexityIcon,
  qwen: qwenIcon,
  'qwen-ai': qwenIcon,
  zai: zaiIcon,
}

function mapOAuthCredentials(providerId: string | undefined, credentials: Record<string, string>): Record<string, string> {
  console.log('[mapOAuthCredentials] Input providerId:', providerId, 'credential keys:', Object.keys(credentials))
  
  if (!providerId) {
    console.log('[mapOAuthCredentials] No providerId, returning as-is')
    return credentials
  }

  const credentialKeyMap: Record<string, string> = {
    'glm': 'chatglm_refresh_token',
    'deepseek': 'userToken',
    'qwen': 'tongyi_sso_ticket',
    'zai': 'tongyi_sso_ticket',
    'perplexity': '__Secure-next-auth.session-token',
  }

  const providerFieldNames: Record<string, string> = {
    'glm': 'refresh_token',
    'deepseek': 'token',
    'qwen': 'ticket',
    'zai': 'ticket',
    'perplexity': 'sessionToken',
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
      let tokenValue = credentials[oauthKey]
      if (providerId === 'deepseek' && tokenValue && tokenValue.startsWith('{') && tokenValue.endsWith('}')) {
        try {
          const parsed = JSON.parse(tokenValue)
          if (parsed.value) {
            tokenValue = parsed.value
          }
        } catch (e) {
          console.error('[mapOAuthCredentials] Error parsing JSON token:', e)
        }
      }
      console.log('[mapOAuthCredentials] Mapped', oauthKey, 'to', fieldName)
      return { [fieldName]: tokenValue }
    }
  }

  if (providerId === 'perplexity' && credentials['__Secure-next-auth.session-token']) {
    console.log('[mapOAuthCredentials] Mapped Perplexity secure token')
    return { sessionToken: credentials['__Secure-next-auth.session-token'] }
  }
  if (providerId === 'perplexity' && credentials['next-auth.session-token']) {
    console.log('[mapOAuthCredentials] Mapped Perplexity session token')
    return { sessionToken: credentials['next-auth.session-token'] }
  }

  if (providerId === 'mimo') {
    console.log('[mapOAuthCredentials] Processing Mimo credentials')
    const result: Record<string, string> = {}
    
    if (credentials['serviceToken']) {
      result['service_token'] = credentials['serviceToken']
      console.log('[mapOAuthCredentials] Mapped serviceToken -> service_token')
    } else if (credentials['service_token']) {
      result['service_token'] = credentials['service_token']
      console.log('[mapOAuthCredentials] Using existing service_token')
    }
    
    if (credentials['userId']) {
      result['user_id'] = credentials['userId']
      console.log('[mapOAuthCredentials] Mapped userId -> user_id')
    } else if (credentials['user_id']) {
      result['user_id'] = credentials['user_id']
      console.log('[mapOAuthCredentials] Using existing user_id')
    }
    
    if (credentials['xiaomichatbot_ph']) {
      result['ph_token'] = credentials['xiaomichatbot_ph']
      console.log('[mapOAuthCredentials] Mapped xiaomichatbot_ph -> ph_token')
    } else if (credentials['ph_token']) {
      result['ph_token'] = credentials['ph_token']
      console.log('[mapOAuthCredentials] Using existing ph_token')
    }
    
    console.log('[mapOAuthCredentials] Mimo result keys:', Object.keys(result))
    return result
  }

  console.log('[mapOAuthCredentials] No special mapping needed, returning as-is')
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
  const [visibleFields, setVisibleFields] = useState<Record<string, boolean>>({})
  const [copiedFields, setCopiedFields] = useState<Record<string, boolean>>({})
  const [browserImportSessionId, setBrowserImportSessionId] = useState<string>('')
  const [browserImportScript, setBrowserImportScript] = useState<string>('')
  const [browserImportPayload, setBrowserImportPayload] = useState<string>('')
  const [isBrowserImportWaiting, setIsBrowserImportWaiting] = useState(false)
  const [browserImportCopied, setBrowserImportCopied] = useState(false)
  const browserImportScriptRef = useRef<HTMLTextAreaElement | null>(null)

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

  const providers = builtinProviders

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

  const supportsOAuth = selectedProviderData && ['deepseek', 'glm', 'kimi', 'mimo', 'minimax', 'qwen', 'qwen-ai', 'zai', 'perplexity'].includes(selectedProviderData.id)
  const isDockerWebAdmin = !!window.__CHAT2API_WEB_ADMIN__
  const supportsBrowserImport = isDockerWebAdmin && selectedProviderData && ['qwen', 'qwen-ai', 'kimi'].includes(selectedProviderData.id)
  const oauthRefreshCredentialFields = selectedProviderData?.id === 'qwen-ai'
    ? selectedProviderData.credentialFields.filter(field => ['email', 'password'].includes(field.name))
    : []

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
      setVisibleFields({})
      setCopiedFields({})
      setBrowserImportSessionId('')
      setBrowserImportScript('')
      setBrowserImportPayload('')
      setIsBrowserImportWaiting(false)
      setBrowserImportCopied(false)
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
      if (result.valid && result.credentials) {
        setCredentials(prev => ({
          ...prev,
          ...result.credentials,
        }))
      }
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
      console.log('[AddProviderDialog] Starting OAuth login for:', selectedProviderData.id)
      
      const result = await window.electronAPI?.oauth.startInAppLogin(
        selectedProviderData.id,
        selectedProviderData.id as ProviderVendor
      )
      
      console.log('[AddProviderDialog] OAuth result:', {
        success: result?.success,
        credentialKeys: result?.credentials ? Object.keys(result.credentials) : [],
        error: result?.error,
      })
      
      if (result?.success && result.credentials) {
        console.log('[AddProviderDialog] OAuth success, credential keys:', Object.keys(result.credentials))
        
        const mappedCredentials = mapOAuthCredentials(selectedProviderData?.id, result.credentials)
        console.log('[AddProviderDialog] Mapped credential keys:', Object.keys(mappedCredentials))
        
        const hasAllRequiredFields = selectedProviderData.credentialFields
          .filter(f => f.required)
          .every(f => mappedCredentials[f.name])
        
        console.log('[AddProviderDialog] Has all required fields:', hasAllRequiredFields)
        console.log('[AddProviderDialog] Required fields:', selectedProviderData.credentialFields.filter(f => f.required).map(f => f.name))
        console.log('[AddProviderDialog] Mapped credentials keys:', Object.keys(mappedCredentials))
        
        if (!hasAllRequiredFields) {
          console.error('[AddProviderDialog] Missing required fields!')
          const missing = selectedProviderData.credentialFields
            .filter(f => f.required && !mappedCredentials[f.name])
            .map(f => f.name)
          console.error('[AddProviderDialog] Missing:', missing)
        }
        
        setCredentials(mappedCredentials)
        setOAuthStatus(t('providers.loginSuccess'))
        
        setValidationResult({
          valid: true,
          userInfo: result.accountInfo
        })
      } else {
        const errorMsg = result?.error || ''
        console.error('[AddProviderDialog] OAuth failed:', errorMsg)
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
      console.error('[AddProviderDialog] OAuth error:', errorMessage)
      setOAuthStatus(errorMessage)
    } finally {
      setIsOAuthLoading(false)
    }
  }

  const startBrowserImport = async () => {
    if (!selectedProviderData || !window.electronAPI?.browserImport) return

    setIsBrowserImportWaiting(true)
    setBrowserImportCopied(false)
    setBrowserImportPayload('')
    setOAuthStatus('')
    setValidationResult({})

    try {
      const session = await window.electronAPI.browserImport.createSession(selectedProviderData.id)
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
      const mappedCredentials = mapOAuthCredentials(selectedProviderData?.id, session.credentials)
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
    if (!selectedProviderData) return

    const loginUrls: Record<string, string> = {
      'qwen-ai': 'https://chat.qwen.ai',
      qwen: 'https://www.qianwen.com',
      kimi: 'https://www.kimi.com',
    }
    await window.electronAPI?.app.openExternal(loginUrls[selectedProviderData.id] || selectedProviderData.apiEndpoint)
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
  }, [browserImportSessionId, isBrowserImportWaiting, selectedProviderData?.id])

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
    setBrowserImportSessionId('')
    setBrowserImportScript('')
    setBrowserImportPayload('')
    setIsBrowserImportWaiting(false)
    setBrowserImportCopied(false)
  }

  const renderCredentialFields = (fieldsOverride?: BuiltinProviderConfig['credentialFields']) => {
    if (!selectedProviderData) return null

    const credentialFields = fieldsOverride || selectedProviderData.credentialFields || []

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

            const providerTranslations = translations[selectedProviderData.id]
            if (providerTranslations && providerTranslations[field.name]) {
              return providerTranslations[field.name]
            }

            return { label: field.label, placeholder: field.placeholder, helpText: field.helpText }
          }

          const translated = getFieldTranslation()
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
                    onChange={(e) => handleCredentialChange(field.name, e.target.value)}
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
                    onChange={(e) => handleCredentialChange(field.name, e.target.value)}
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
                    'flex items-start justify-between p-3 rounded-lg border cursor-pointer transition-colors',
                    selectedProvider === provider.id
                      ? 'border-primary bg-primary/5'
                      : 'hover:bg-muted/50'
                  )}
                  onClick={() => setSelectedProvider(provider.id)}
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center overflow-hidden flex-shrink-0">
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
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{getProviderName(provider)}</span>
                        <Badge variant="outline" className="text-xs">
                          {t('providers.builtin')}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {getProviderDescription(provider)}
                      </p>
                      {provider.id === 'perplexity' && (
                        <p className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 mt-1">
                          <Info className="h-3 w-3 flex-shrink-0" />
                          <span>{t('perplexity.freeUserNotice')}</span>
                        </p>
                      )}
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
                    <Check className="h-5 w-5 text-primary flex-shrink-0 ml-2" />
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
              {supportsBrowserImport ? (
                <div className="space-y-4">
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                    <p className="font-medium text-foreground">{t('providers.browserImportTitle')}</p>
                    <p className="mt-1">{t('providers.browserImportDesc')}</p>
                  </div>
                  {oauthRefreshCredentialFields.length > 0 && (
                    <div className="rounded-lg border p-3">
                      {renderCredentialFields(oauthRefreshCredentialFields)}
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
                      {renderCredentialFields(oauthRefreshCredentialFields)}
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
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
