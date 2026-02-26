import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from '@/components/ui/select'
import { Plus, Search, Filter, Server, RefreshCw } from 'lucide-react'
import { ProviderCard } from './ProviderCard'
import type { Provider, ProviderStatus } from '@/types/electron'

interface ProviderListProps {
  providers: Provider[]
  providerStatuses: Record<string, ProviderStatus>
  accountCounts: Record<string, { total: number; active: number }>
  onToggle: (id: string, enabled: boolean) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onDuplicate: (id: string) => void
  onCheckStatus: (id: string) => void
  onCheckAllStatus: () => void
  onManageAccounts: (id: string) => void
  onAddProvider: () => void
}

type FilterType = 'all' | 'builtin' | 'custom' | 'enabled' | 'disabled'

export function ProviderList({
  providers,
  providerStatuses,
  accountCounts,
  onToggle,
  onEdit,
  onDelete,
  onDuplicate,
  onCheckStatus,
  onCheckAllStatus,
  onManageAccounts,
  onAddProvider,
}: ProviderListProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState<FilterType>('all')
  const [isRefreshing, setIsRefreshing] = useState(false)

  const filteredProviders = providers.filter((provider) => {
    const matchesSearch = 
      provider.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      provider.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      provider.supportedModels?.some(model => 
        model.toLowerCase().includes(searchQuery.toLowerCase())
      )

    if (!matchesSearch) return false

    switch (filter) {
      case 'builtin':
        return provider.type === 'builtin'
      case 'custom':
        return provider.type === 'custom'
      case 'enabled':
        return provider.enabled
      case 'disabled':
        return !provider.enabled
      default:
        return true
    }
  })

  const handleCheckAllStatus = async () => {
    setIsRefreshing(true)
    await onCheckAllStatus()
    setTimeout(() => setIsRefreshing(false), 1000)
  }

  const stats = {
    total: providers.length,
    builtin: providers.filter(p => p.type === 'builtin').length,
    custom: providers.filter(p => p.type === 'custom').length,
    enabled: providers.filter(p => p.enabled).length,
    online: Object.values(providerStatuses).filter(s => s === 'online').length,
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search providers..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 w-64"
            />
          </div>
          <Select value={filter} onValueChange={(v) => setFilter(v as FilterType)}>
            <SelectTrigger className="w-36">
              <Filter className="mr-2 h-4 w-4" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="builtin">Built-in</SelectItem>
              <SelectItem value="custom">Custom</SelectItem>
              <SelectItem value="enabled">Enabled</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCheckAllStatus}
            disabled={isRefreshing}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh Status
          </Button>
          <Button size="sm" onClick={onAddProvider}>
            <Plus className="mr-2 h-4 w-4" />
            Add Provider
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <span>Total {stats.total} providers</span>
        <span>•</span>
        <span>{stats.online} online</span>
        <span>•</span>
        <span>{stats.enabled} enabled</span>
        <span>•</span>
        <span>{stats.builtin} built-in, {stats.custom} custom</span>
      </div>

      {filteredProviders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Server className="h-12 w-12 mb-4 opacity-50" />
          <p className="text-lg font-medium">No providers found</p>
          <p className="text-sm">
            {searchQuery || filter !== 'all' 
              ? 'Try adjusting your search or filter'
              : 'Click the button above to add your first provider'}
          </p>
        </div>
      ) : (
        <ScrollArea className="h-[calc(100vh-280px)]">
          <div className="grid gap-4 pr-4">
            {filteredProviders.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                status={providerStatuses[provider.id]}
                accountCount={accountCounts[provider.id]?.total || 0}
                activeAccountCount={accountCounts[provider.id]?.active || 0}
                onToggle={onToggle}
                onEdit={onEdit}
                onDelete={onDelete}
                onDuplicate={onDuplicate}
                onCheckStatus={onCheckStatus}
                onManageAccounts={onManageAccounts}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

export default ProviderList
