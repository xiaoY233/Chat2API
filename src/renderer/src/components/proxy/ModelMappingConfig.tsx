import { useState, useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Combobox, type ComboboxOption } from '@/components/ui/combobox'
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
import { useNavigationStore } from '@/stores/navigationStore'
import { useToast } from '@/hooks/use-toast'
import type { ModelMapping, Provider, Account } from '@/types/electron'
import { ArrowRight, Plus, Pencil, Trash2, Search, Sparkles, Save, RotateCcw, AlertTriangle } from 'lucide-react'

interface ModelMappingConfigProps {
  onConfigChange?: () => void
}

interface MappingFormData {
  requestModel: string
  actualModel: string
  preferredProviderId: string
  preferredAccountId: string
}

const BLOCKER_ID = 'model-mapping-changes'

export function ModelMappingConfig({ onConfigChange }: ModelMappingConfigProps) {
  const { t } = useTranslation()
  const {
    modelMappings,
    setModelMappings,
    saveAppConfig,
    isLoading,
  } = useProxyStore()
  const { registerBlocker, unregisterBlocker } = useNavigationStore()
  const { toast } = useToast()
  
  const [mappings, setMappings] = useState<ModelMapping[]>([])
  const [originalMappings, setOriginalMappings] = useState<ModelMapping[]>([])
  const [providers, setProviders] = useState<Provider[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingMapping, setEditingMapping] = useState<ModelMapping | null>(null)
  const [hasChanges, setHasChanges] = useState(false)
  const isInitializedRef = useRef(false)
  
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
    if (!isInitializedRef.current && modelMappings.length >= 0) {
      setMappings([...modelMappings])
      setOriginalMappings([...modelMappings])
      isInitializedRef.current = true
    }
  }, [modelMappings])

  useEffect(() => {
    if (hasChanges) {
      registerBlocker(BLOCKER_ID, t('proxy.unsavedChangesDescription'))
    } else {
      unregisterBlocker(BLOCKER_ID)
    }
    return () => unregisterBlocker(BLOCKER_ID)
  }, [hasChanges, registerBlocker, unregisterBlocker, t])

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasChanges) {
        e.preventDefault()
        e.returnValue = t('proxy.unsavedChangesWarning')
        return e.returnValue
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [hasChanges, t])

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
    }

    setHasChanges(true)
    onConfigChange?.()
    handleCloseDialog()
    
    toast({
      title: editingMapping ? t('providers.updateSuccess') : t('providers.addSuccess'),
      description: t(editingMapping ? 'proxy.mappingUpdatedPending' : 'proxy.mappingAddedPending', { model: mapping.requestModel }),
    })
  }

  const handleDeleteMapping = (requestModel: string) => {
    const updatedMappings = mappings.filter(m => m.requestModel !== requestModel)
    setMappings(updatedMappings)
    setHasChanges(true)
    onConfigChange?.()
    
    toast({
      title: t('providers.deleteSuccess'),
      description: t('proxy.mappingDeletedPending', { model: requestModel }),
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
      setModelMappings(mappings)
      setOriginalMappings([...mappings])
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
    setMappings([...originalMappings])
    setHasChanges(false)
    toast({
      description: t('proxy.changesDiscarded'),
    })
  }

  const filteredAccounts = formData.preferredProviderId
    ? accounts.filter(a => a.providerId === formData.preferredProviderId)
    : accounts

  const isWildcard = formData.requestModel.includes('*')

  const modelOptions: ComboboxOption[] = useMemo(() => {
    const options: ComboboxOption[] = []
    const addedModels = new Set<string>()

    providers.forEach(provider => {
      provider.supportedModels?.forEach(model => {
        if (!addedModels.has(model)) {
          addedModels.add(model)
          options.push({
            value: model,
            label: model,
            group: provider.name,
          })
        }
      })
    })

    return options.sort((a, b) => a.value.localeCompare(b.value))
  }, [providers])

  const handleModelChange = (value: string) => {
    setFormData(prev => ({ ...prev, actualModel: value }))
  }

  return (
    <Card className={hasChanges ? 'ring-2 ring-amber-500/50' : ''}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ArrowRight className="h-5 w-5 text-primary" />
            <CardTitle>{t('proxy.modelMappingConfig')}</CardTitle>
          </div>
          {hasChanges && (
            <Badge variant="outline" className="bg-amber-500/10 text-amber-600 border-amber-500/50 gap-1">
              <AlertTriangle className="h-3 w-3" />
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
      </CardContent>

      {hasChanges && (
        <div className="border-t bg-gradient-to-r from-amber-50 to-orange-50 dark:from-amber-950/30 dark:to-orange-950/30 p-4 rounded-b-[16px]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              <span className="text-amber-700 dark:text-amber-400 font-medium">{t('proxy.unsavedChangesHint')}</span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReset}
                disabled={isLoading}
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                {t('common.reset')}
              </Button>
              <Button
                size="sm"
                onClick={handleSaveAll}
                disabled={isLoading}
                className="bg-amber-600 hover:bg-amber-700"
              >
                <Save className="h-4 w-4 mr-2" />
                {isLoading ? t('providers.saving') : t('proxy.saveConfig')}
              </Button>
            </div>
          </div>
        </div>
      )}

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
              <Combobox
                options={modelOptions}
                value={formData.actualModel}
                onChange={handleModelChange}
                placeholder={t('proxy.selectModel')}
                emptyText={t('proxy.noModelFound')}
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
