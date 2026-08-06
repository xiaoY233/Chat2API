/**
 * Token Manual Input Component
 * For manual token input across providers
 */

import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { ExternalLink, Eye, EyeOff, HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface TokenInputProps {
  label: string
  placeholder: string
  description: string
  helpUrl?: string
  value: string
  onChange: (value: string) => void
  onSubmit?: () => void
  isPassword?: boolean
  disabled?: boolean
  error?: string
  className?: string
}

export function TokenInput({
  label,
  placeholder,
  description,
  helpUrl,
  value,
  onChange,
  onSubmit,
  isPassword = true,
  disabled = false,
  error,
  className,
}: TokenInputProps) {
  const { t } = useTranslation()
  const [showToken, setShowToken] = useState(false)

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && onSubmit) {
      onSubmit()
    }
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between">
        <Label htmlFor="token-input" className="text-sm font-medium">
          {label}
        </Label>
        {helpUrl && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => window.electronAPI?.invoke('app:openExternal', helpUrl)}
          >
            <HelpCircle className="mr-1 h-3 w-3" />
            {t('oauth.help')}
            <ExternalLink className="ml-1 h-3 w-3" />
          </Button>
        )}
      </div>
      
      <div className="relative">
        <Input
          id="token-input"
          type={isPassword && !showToken ? 'password' : 'text'}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className={cn(
            'pr-10',
            error && 'border-destructive focus-visible:ring-destructive'
          )}
          autoComplete="off"
        />
        {isPassword && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
            onClick={() => setShowToken(!showToken)}
            tabIndex={-1}
          >
            {showToken ? (
              <EyeOff className="h-4 w-4 text-muted-foreground" />
            ) : (
              <Eye className="h-4 w-4 text-muted-foreground" />
            )}
          </Button>
        )}
      </div>
      
      <p className="text-xs text-muted-foreground">
        {description}
      </p>
      
      {error && (
        <p className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

export default TokenInput
