/**
 * OAuth Progress Display Component
 * Shows progress status of OAuth login flow
 */

import { useTranslation } from 'react-i18next'
import { Loader2, CheckCircle2, XCircle, Circle } from 'lucide-react'
import { cn } from '@/lib/utils'

export type OAuthProgressStatus = 'idle' | 'pending' | 'success' | 'error' | 'cancelled'

export interface OAuthProgressProps {
  status: OAuthProgressStatus
  message: string
  progress?: number
  className?: string
}

export function OAuthProgress({
  status,
  message,
  progress,
  className,
}: OAuthProgressProps) {
  const { t } = useTranslation()
  
  const statusConfig = {
    idle: {
      icon: Circle,
      iconClass: 'text-muted-foreground',
      textClass: 'text-muted-foreground',
      labelKey: 'oauth.pending',
    },
    pending: {
      icon: Loader2,
      iconClass: 'text-primary animate-spin',
      textClass: 'text-foreground',
      labelKey: 'oauth.inProgress',
    },
    success: {
      icon: CheckCircle2,
      iconClass: 'text-green-500',
      textClass: 'text-green-600',
      labelKey: 'oauth.success',
    },
    error: {
      icon: XCircle,
      iconClass: 'text-destructive',
      textClass: 'text-destructive',
      labelKey: 'oauth.failed',
    },
    cancelled: {
      icon: XCircle,
      iconClass: 'text-orange-500',
      textClass: 'text-orange-600',
      labelKey: 'oauth.cancelled',
    },
  }

  const config = statusConfig[status]
  const Icon = config.icon

  return (
    <div className={cn('flex flex-col items-center justify-center space-y-4 p-6', className)}>
      <div className="relative">
        <Icon className={cn('h-12 w-12', config.iconClass)} />
        {status === 'pending' && progress !== undefined && (
          <svg className="absolute inset-0 h-12 w-12 -rotate-90">
            <circle
              cx="24"
              cy="24"
              r="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-muted opacity-20"
            />
            <circle
              cx="24"
              cy="24"
              r="20"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={`${progress * 1.256} 125.6`}
              className="text-primary"
            />
          </svg>
        )}
      </div>
      
      <div className="text-center">
        <p className={cn('text-sm font-medium', config.textClass)}>
          {t(config.labelKey)}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {message}
        </p>
      </div>
      
      {status === 'pending' && (
        <div className="w-full max-w-xs">
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress || 0}%` }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

export default OAuthProgress
