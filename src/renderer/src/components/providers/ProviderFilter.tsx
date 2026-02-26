/**
 * Provider Filter Component
 * Supports filtering by type, status and search
 */

import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { 
  Search, 
  Filter, 
  X, 
  Server, 
  RefreshCw,
  Plus,
  Layers,
  CheckCircle2,
  XCircle,
} from 'lucide-react'
import type { ProviderStatus, ProviderType } from '@/types/electron'
import { cn } from '@/lib/utils'

export type FilterType = 'all' | ProviderType | 'enabled' | 'disabled'
export type StatusFilter = 'all' | ProviderStatus

interface ProviderFilterProps {
  searchQuery: string
  onSearchChange: (query: string) => void
  typeFilter: FilterType
  onTypeFilterChange: (filter: FilterType) => void
  statusFilter: StatusFilter
  onStatusFilterChange: (filter: StatusFilter) => void
  onRefresh: () => void
  onAddProvider: () => void
  isRefreshing?: boolean
  stats?: {
    total: number
    builtin: number
    custom: number
    enabled: number
    online: number
  }
}

export function ProviderFilter({
  searchQuery,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  statusFilter,
  onStatusFilterChange,
  onRefresh,
  onAddProvider,
  isRefreshing = false,
  stats,
}: ProviderFilterProps) {
  const { t } = useTranslation()

  const typeFilterOptions: { value: FilterType; labelKey: string; icon: typeof Server }[] = [
    { value: 'all', labelKey: 'providers.allTypes', icon: Layers },
    { value: 'builtin', labelKey: 'providers.builtin', icon: Server },
    { value: 'custom', labelKey: 'providers.custom', icon: Server },
    { value: 'enabled', labelKey: 'providers.enabledOnly', icon: CheckCircle2 },
    { value: 'disabled', labelKey: 'providers.disabledOnly', icon: XCircle },
  ]

  const statusFilterOptions: { value: StatusFilter; labelKey: string; color: string }[] = [
    { value: 'all', labelKey: 'providers.allStatus', color: 'bg-gray-500' },
    { value: 'online', labelKey: 'providers.online', color: 'bg-green-500' },
    { value: 'offline', labelKey: 'providers.offline', color: 'bg-red-500' },
    { value: 'unknown', labelKey: 'providers.unknown', color: 'bg-gray-400' },
  ]

  const hasActiveFilters = typeFilter !== 'all' || statusFilter !== 'all' || searchQuery !== ''

  const handleClearFilters = () => {
    onSearchChange('')
    onTypeFilterChange('all')
    onStatusFilterChange('all')
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('providers.searchProviders')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9 pr-9"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
              onClick={() => onSearchChange('')}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Select value={typeFilter} onValueChange={(v) => onTypeFilterChange(v as FilterType)}>
            <SelectTrigger className="w-[140px]">
              <Filter className="mr-2 h-4 w-4" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {typeFilterOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className={cn(statusFilter !== 'all' && 'border-primary')}>
                <div className={cn(
                  'w-2 h-2 rounded-full',
                  statusFilterOptions.find(s => s.value === statusFilter)?.color
                )} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {statusFilterOptions.map((option) => (
                <DropdownMenuCheckboxItem
                  key={option.value}
                  checked={statusFilter === option.value}
                  onCheckedChange={() => onStatusFilterChange(option.value)}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn('w-2 h-2 rounded-full', option.color)} />
                    <span>{t(option.labelKey)}</span>
                  </div>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="icon"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            <RefreshCw className={cn('h-4 w-4', isRefreshing && 'animate-spin')} />
          </Button>

          <Button onClick={onAddProvider}>
            <Plus className="mr-2 h-4 w-4" />
            {t('providers.addProvider')}
          </Button>
        </div>
      </div>

      {hasActiveFilters && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-foreground">{t('logs.filter')}:</span>
          
          {searchQuery && (
            <Badge variant="secondary" className="gap-1">
              {t('common.search')}: {searchQuery}
              <X 
                className="h-3 w-3 cursor-pointer" 
                onClick={() => onSearchChange('')}
              />
            </Badge>
          )}
          
          {typeFilter !== 'all' && (
            <Badge variant="secondary" className="gap-1">
              {t('providers.providerType')}: {t(typeFilterOptions.find(t => t.value === typeFilter)?.labelKey || '')}
              <X 
                className="h-3 w-3 cursor-pointer" 
                onClick={() => onTypeFilterChange('all')}
              />
            </Badge>
          )}
          
          {statusFilter !== 'all' && (
            <Badge variant="secondary" className="gap-1">
              {t('providers.status')}: {t(statusFilterOptions.find(s => s.value === statusFilter)?.labelKey || '')}
              <X 
                className="h-3 w-3 cursor-pointer" 
                onClick={() => onStatusFilterChange('all')}
              />
            </Badge>
          )}
          
          <Button 
            variant="ghost" 
            size="sm" 
            className="h-6 px-2 text-xs"
            onClick={handleClearFilters}
          >
            {t('common.reset')}
          </Button>
        </div>
      )}

      {stats && (
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span>{t('providers.total')}: {stats.total}</span>
          <span>•</span>
          <span className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-green-500" />
            {stats.online} {t('providers.onlineCount')}
          </span>
          <span>•</span>
          <span>{stats.enabled} {t('providers.enabled')}</span>
          <span>•</span>
          <span>{stats.builtin} {t('providers.builtin')}, {stats.custom} {t('providers.custom')}</span>
        </div>
      )}
    </div>
  )
}

export default ProviderFilter
