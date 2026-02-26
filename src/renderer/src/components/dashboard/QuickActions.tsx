import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { Play, Square, Plus, FileText, Zap, Loader2 } from 'lucide-react'

export interface QuickActionsProps {
  proxyRunning: boolean
  onToggleProxy: () => void
  onAddAccount: () => void
  onViewLogs: () => void
  isLoading?: boolean
  className?: string
}

export function QuickActions({
  proxyRunning,
  onToggleProxy,
  onAddAccount,
  onViewLogs,
  isLoading,
  className,
}: QuickActionsProps) {
  const { t } = useTranslation()

  return (
    <Card className={cn('', className)}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
            <Zap className="h-4 w-4 text-[var(--accent-primary)]" />
          </div>
          {t('quickActions.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          className="w-full justify-start"
          variant={proxyRunning ? 'destructive' : 'default'}
          onClick={onToggleProxy}
          disabled={isLoading}
        >
          {isLoading ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : proxyRunning ? (
            <Square className="mr-2 h-4 w-4" />
          ) : (
            <Play className="mr-2 h-4 w-4" />
          )}
          {isLoading
            ? t('common.loading')
            : proxyRunning
            ? t('quickActions.stopProxy')
            : t('quickActions.startProxy')}
          {proxyRunning && !isLoading && (
            <Badge variant="secondary" className="ml-auto">
              {t('dashboard.running')}
            </Badge>
          )}
        </Button>

        <Button
          className="w-full justify-start"
          variant="outline"
          onClick={onAddAccount}
        >
          <Plus className="mr-2 h-4 w-4" />
          {t('quickActions.addAccount')}
        </Button>

        <Button
          className="w-full justify-start"
          variant="outline"
          onClick={onViewLogs}
        >
          <FileText className="mr-2 h-4 w-4" />
          {t('quickActions.viewLogs')}
        </Button>
      </CardContent>
    </Card>
  )
}
