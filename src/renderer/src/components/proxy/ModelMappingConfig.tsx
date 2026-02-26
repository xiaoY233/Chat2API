import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useProxyStore } from '@/stores/proxyStore'
import { useToast } from '@/hooks/use-toast'
import type { ModelMapping, Provider, Account } from '@/types/electron'
import { ArrowRight, Plus, Pencil, Trash2, Search, Sparkles } from 'lucide-react'

interface ModelMappingConfigProps {
  onConfigChange?: () => void
}

interface MappingFormData {
  requestModel: string
  actualModel: string
  preferredProviderId: string
  preferredAccountId: string
}

export function ModelMappingConfig({ onConfigChange }: ModelMappingConfigProps) {
  const { t } = useTranslation()
  const {
    modelMappings,
    addModelMapping,
    updateModelMapping,
    removeModelMapping,
    saveAppConfig,
    isLoading,
  } = useProxyStore()
  const { toast } = useToast()
  
  const [mappings, setMappings] = useState<ModelMapping[]>(modelMappings)
  const [providers, setProviders] = useState<Provider[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingMapping, setEditingMapping] = useState<ModelMapping | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  
  const [formData, setFormData] = useState<MappingFormData>({
    requestModel: '',
    actualModel: '',
    preferredProviderId: '',
    preferredAccountId: '',
  })

  const AUTO_SELECT_VALUE = 'auto'

  const WILDCARD_EXAMPLES = [
    { pattern: 'gpt-*', description: t('proxy.wildcardMappingDesc') },
    { pattern: '*-turbo', description: t('proxy.wildcardMappingDesc') },
    { pattern: 'claude-*-latest', description: t('proxy.wildcardMappingDesc') },
  ]

  useEffect(() => {
    fetchProviders()
    fetchAccounts()
  }, [])

  useEffect(() => {
    setMappings(modelMappings)
  }, [modelMappings])

  const fetchProviders = async () => {
    try {
      const data = await window.electronAPI.providers.getAll()
      setProviders(data.filter(p => p.enabled))
    } catch (error) {
      console.error('Failed to fetch providers:', error)
    }
  }

  const fetchAccounts = async () => {
    try {
      const data = await window.electronAPI.accounts.getAll()
      setAccounts(data.filter(a => a.status === 'active'))
    } catch (error) {
      console.error('Failed to fetch accounts:', error)
    }
  }

  const filteredMappings = mappings.filter(m =>
    m.requestModel.toLowerCase().includes(searchQuery.toLowerCase()) ||
    m.actualModel.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleOpenDialog = (mapping?: ModelMapping) => {
    if (mapping) {
      setEditingMapping(mapping)
      setFormData({
        requestModel: mapping.requestModel,
        actualModel: mapping.actualModel,
        preferredProviderId: mapping.preferredProviderId || AUTO_SELECT_VALUE,
        preferredAccountId: mapping.preferredAccountId || AUTO_SELECT_VALUE,
      })
    } else {
      setEditingMapping(null)
      setFormData({
        requestModel: '',
        actualModel: '',
        preferredProviderId: '',
        preferredAccountId: '',
      })
    }
    setIsDialogOpen(true)
  }

  const handleCloseDialog = () => {
    setIsDialogOpen(false)
    setEditingMapping(null)
    setFormData({
      requestModel: '',
      actualModel: '',
      preferredProviderId: '',
      preferredAccountId: '',
    })
  }

  const handleSaveMapping = async () => {
    if (!formData.requestModel.trim() || !formData.actualModel.trim()) {
      toast({
        title: t('proxy.validationFailed'),
        description: t('proxy.requestActualModelRequired'),
        variant: 'destructive',
      })
      return
    }

    const mapping: ModelMapping = {
      requestModel: formData.requestModel.trim(),
      actualModel: formData.actualModel.trim(),
      preferredProviderId: formData.preferredProviderId === AUTO_SELECT_VALUE ? undefined : formData.preferredProviderId || undefined,
      preferredAccountId: formData.preferredAccountId === AUTO_SELECT_VALUE ? undefined : formData.preferredAccountId || undefined,
    }

    if (editingMapping) {
      const updatedMappings = mappings.map(m =>
        m.requestModel === editingMapping.requestModel ? mapping : m
      )
      setMappings(updatedMappings)
      updateModelMapping(editingMapping.requestModel, mapping)
    } else {
      if (mappings.some(m => m.requestModel === mapping.requestModel)) {
        toast({
          title: t('proxy.validationFailed'),
          description: t('proxy.mappingExists'),
          variant: 'destructive',
        })
        return
      }
      setMappings([...mappings, mapping])
      addModelMapping(mapping)
    }

    setHasChanges(true)
    onConfigChange?.()
    handleCloseDialog()
    
    toast({
      title: editingMapping ? t('providers.updateSuccess') : t('providers.addSuccess'),
      description: t(editingMapping ? 'proxy.mappingUpdated' : 'proxy.mappingAdded', { model: mapping.requestModel }),
    })
  }

  const handleDeleteMapping = (requestModel: string) => {
    const updatedMappings = mappings.filter(m => m.requestModel !== requestModel)
    setMappings(updatedMappings)
    removeModelMapping(requestModel)
    setHasChanges(true)
    onConfigChange?.()
    
    toast({
      title: t('providers.deleteSuccess'),
      description: t('proxy.mappingDeleted', { model: requestModel }),
    })
  }

  const handleSaveAll = async () => {
    const mappingRecord: Record<string, ModelMapping> = {}
    for (const mapping of mappings) {
      mappingRecord[mapping.requestModel] = mapping
    }

    const success = await saveAppConfig({
      modelMappings: mappingRecord,
    })

    if (success) {
      setHasChanges(false)
      toast({
        title: t('providers.updateSuccess'),
        description: t('proxy.configSaved'),
      })
    } else {
      toast({
        title: t('providers.updateFailed'),
        description: t('proxy.configSaveFailed'),
        variant: 'destructive',
      })
    }
  }

  const handleReset = () => {
    setMappings(modelMappings)
    setHasChanges(false)
  }

  const filteredAccounts = formData.preferredProviderId
    ? accounts.filter(a => a.providerId === formData.preferredProviderId)
    : accounts

  const isWildcard = formData.requestModel.includes('*')

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowRight className="h-5 w-5 text-primary" />
            <CardTitle>{t('proxy.modelMappingConfig')}</CardTitle>
          </div>
          {hasChanges && (
            <Badge variant="secondary" className="text-xs">
              {t('proxy.unsaved')}
            </Badge>
          )}
        </div>
        <CardDescription>{t('proxy.modelMappingDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t('proxy.searchMappings')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button onClick={() => handleOpenDialog()}>
            <Plus className="h-4 w-4 mr-2" />
            {t('proxy.addMapping')}
          </Button>
        </div>

        {filteredMappings.length > 0 ? (
          <div className="border rounded-lg">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('proxy.requestModel')}</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                  <TableHead>{t('proxy.actualModel')}</TableHead>
                  <TableHead>{t('proxy.preferredProvider')}</TableHead>
                  <TableHead>{t('proxy.preferredAccount')}</TableHead>
                  <TableHead className="w-[100px]">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredMappings.map((mapping) => {
                  const provider = providers.find(p => p.id === mapping.preferredProviderId)
                  const account = accounts.find(a => a.id === mapping.preferredAccountId)
                  const isWildcardMapping = mapping.requestModel.includes('*')
                  
                  return (
                    <TableRow key={mapping.requestModel}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {isWildcardMapping && (
                            <Sparkles className="h-4 w-4 text-amber-500" />
                          )}
                          <code className="text-sm">{mapping.requestModel}</code>
                        </div>
                      </TableCell>
                      <TableCell>
                        <ArrowRight className="h-4 w-4 text-muted-foreground" />
                      </TableCell>
                      <TableCell>
                        <code className="text-sm">{mapping.actualModel}</code>
                      </TableCell>
                      <TableCell>
                        {provider ? (
                          <Badge variant="outline">{provider.name}</Badge>
                        ) : (
                          <span className="text-muted-foreground text-sm">{t('proxy.auto')}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {account ? (
                          <span className="text-sm">{account.name}</span>
                        ) : (
                          <span className="text-muted-foreground text-sm">{t('proxy.auto')}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleOpenDialog(mapping)}
                            className="h-8 w-8"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteMapping(mapping.requestModel)}
                            className="h-8 w-8 text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground border rounded-lg">
            <p className="text-sm">{t('proxy.noMappings')}</p>
            <p className="text-xs mt-1">{t('proxy.noMappingsDesc')}</p>
          </div>
        )}

        <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
          <Sparkles className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
          <div className="space-y-1">
            <p className="text-sm font-medium">{t('proxy.wildcardMapping')}</p>
            <p className="text-xs text-muted-foreground">
              {t('proxy.wildcardMappingDesc')}
            </p>
            <div className="flex flex-wrap gap-2 mt-2">
              {WILDCARD_EXAMPLES.map((example) => (
                <code
                  key={example.pattern}
                  className="text-xs bg-background px-2 py-1 rounded cursor-pointer hover:bg-background/80"
                  title={example.description}
                  onClick={() => setFormData(prev => ({ ...prev, requestModel: example.pattern }))}
                >
                  {example.pattern}
                </code>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end space-x-2 pt-4">
          <Button
            variant="outline"
            onClick={handleReset}
            disabled={!hasChanges || isLoading}
          >
            {t('common.reset')}
          </Button>
          <Button
            onClick={handleSaveAll}
            disabled={!hasChanges || isLoading}
          >
            {isLoading ? t('providers.saving') : t('proxy.saveConfig')}
          </Button>
        </div>
      </CardContent>

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editingMapping ? t('proxy.editMapping') : t('proxy.addMapping')}
            </DialogTitle>
            <DialogDescription>
              {t('proxy.addMappingDesc')}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="requestModel">
                {t('proxy.requestModel')}
                {isWildcard && (
                  <Badge variant="outline" className="ml-2 text-xs">
                    {t('proxy.wildcard')}
                  </Badge>
                )}
              </Label>
              <Input
                id="requestModel"
                placeholder={t('proxy.requestModelPlaceholder')}
                value={formData.requestModel}
                onChange={(e) => setFormData(prev => ({ ...prev, requestModel: e.target.value }))}
                disabled={!!editingMapping}
              />
              <p className="text-xs text-muted-foreground">
                {t('proxy.requestModelHelp')}
              </p>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="actualModel">{t('proxy.actualModel')}</Label>
              <Input
                id="actualModel"
                placeholder="deepseek-chat"
                value={formData.actualModel}
                onChange={(e) => setFormData(prev => ({ ...prev, actualModel: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">
                {t('proxy.actualModelHelp')}
              </p>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="provider">{t('proxy.preferredProviderOptional')}</Label>
              <Select
                value={formData.preferredProviderId}
                onValueChange={(value) => setFormData(prev => ({
                  ...prev,
                  preferredProviderId: value,
                  preferredAccountId: '',
                }))}
              >
                <SelectTrigger id="provider">
                  <SelectValue placeholder={t('proxy.autoSelect')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_SELECT_VALUE}>{t('proxy.autoSelect')}</SelectItem>
                  {providers.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="account">{t('proxy.preferredAccountOptional')}</Label>
              <Select
                value={formData.preferredAccountId}
                onValueChange={(value) => setFormData(prev => ({ ...prev, preferredAccountId: value }))}
                disabled={!formData.preferredProviderId}
              >
                <SelectTrigger id="account">
                  <SelectValue placeholder={formData.preferredProviderId ? t('proxy.autoSelect') : t('proxy.selectProviderFirst')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={AUTO_SELECT_VALUE}>{t('proxy.autoSelect')}</SelectItem>
                  {filteredAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={handleCloseDialog}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSaveMapping}>
              {editingMapping ? t('providers.updateSuccess') : t('common.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

export default ModelMappingConfig
