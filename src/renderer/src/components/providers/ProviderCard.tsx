import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuSeparator, 
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu'
import { 
  MoreVertical, 
  Edit, 
  Trash2, 
  Copy, 
  RefreshCw, 
  Users,
  Plus,
  LogIn
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Provider, ProviderStatus } from '@/types/electron'
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

interface ProviderCardProps {
  provider: Provider
  status?: ProviderStatus
  accountCount: number
  activeAccountCount: number
  onToggle: (id: string, enabled: boolean) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onCheckStatus: (id: string) => void
  onManageAccounts: (id: string) => void
  className?: string
}

const statusColors: Record<ProviderStatus, string> = {
  online: 'bg-green-500',
  offline: 'bg-red-500',
  unknown: 'bg-gray-500',
}

export function ProviderCard({
  provider,
  status,
  accountCount,
  activeAccountCount,
  onToggle,
  onEdit,
  onDelete,
  onDuplicate,
  onCheckStatus,
  onManageAccounts,
  className,
}: ProviderCardProps) {
  const { t } = useTranslation()
  const isBuiltin = provider.type === 'builtin'
  const icon = providerIcons[provider.id]
  const currentStatus = provider.status || status || 'unknown'

  const statusTexts: Record<ProviderStatus, string> = {
    online: t('providers.online'),
    offline: t('providers.offline'),
    unknown: t('providers.unknown'),
  }

  const getProviderName = () => {
    if (isBuiltin && provider.id) {
      return t(`${provider.id}.name`, { defaultValue: provider.name })
    }
    return provider.name
  }

  const getProviderDescription = () => {
    if (isBuiltin && provider.id) {
      return t(`${provider.id}.description`, { defaultValue: provider.description })
    }
    return provider.description
  }

  return (
    <Card hover className={cn('', className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-[var(--accent-primary)]/10 flex items-center justify-center overflow-hidden">
            {icon ? (
              <img 
                src={icon} 
                alt={provider.name}
                className="h-8 w-8 object-contain"
              />
            ) : (
              <span className="text-xl">🔌</span>
            )}
          </div>
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              {getProviderName()}
              {isBuiltin && (
                <Badge variant="outline" className="text-xs">
                  {t('providers.builtin')}
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              {getProviderDescription() || `${provider.supportedModels?.length || 0} ${t('providers.models').toLowerCase()}`}
            </CardDescription>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className={`w-2 h-2 rounded-full ${statusColors[currentStatus]}`} />
            <span className="text-xs text-muted-foreground">{statusTexts[currentStatus]}</span>
          </div>
          <Switch
            checked={provider.enabled}
            onCheckedChange={(checked) => onToggle(provider.id, checked)}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onManageAccounts(provider.id)}>
                <Users className="mr-2 h-4 w-4" />
                {t('providers.accountManagement')} ({activeAccountCount}/{accountCount})
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onCheckStatus(provider.id)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t('providers.checkStatus')}
              </DropdownMenuItem>
              {!isBuiltin && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onEdit(provider.id)}>
                    <Edit className="mr-2 h-4 w-4" />
                    {t('providers.editProvider')}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onDuplicate(provider.id)}>
                    <Copy className="mr-2 h-4 w-4" />
                    {t('providers.duplicateProvider')}
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem 
                onClick={() => onDelete(provider.id)}
                className="text-destructive"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {t('providers.deleteProvider')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div className="grid grid-cols-3 gap-4 text-sm flex-1">
            <div className="flex flex-col">
              <span className="text-muted-foreground text-xs">{t('providers.accounts')}</span>
              <span className="font-medium">
                {activeAccountCount} / {accountCount} {t('providers.online').toLowerCase()}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground text-xs">{t('providers.models')}</span>
              <span className="font-medium">
                {provider.supportedModels?.length || 0}
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-muted-foreground text-xs">{t('providers.authType')}</span>
              <span className="font-medium text-xs truncate">
                {getAuthTypeLabel(provider.authType)}
              </span>
            </div>
          </div>
          
          <Button
            size="sm"
            variant={accountCount === 0 ? 'default' : 'outline'}
            onClick={() => onManageAccounts(provider.id)}
            className="ml-4 shrink-0"
          >
            {accountCount === 0 ? (
              <>
                <Plus className="h-4 w-4 mr-1" />
                {t('providers.addAccount')}
              </>
            ) : (
              <>
                <LogIn className="h-4 w-4 mr-1" />
                {t('providers.accountManagement')}
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function getAuthTypeLabel(authType: string): string {
  const labels: Record<string, string> = {
    oauth: 'OAuth',
    token: 'API Key',
    cookie: 'Cookie',
    userToken: 'User Token',
    refresh_token: 'Refresh Token',
    jwt: 'JWT',
    realUserID_token: 'UserID+Token',
    tongyi_sso_ticket: 'SSO Ticket',
  }
  return labels[authType] || authType
}

export default ProviderCard
