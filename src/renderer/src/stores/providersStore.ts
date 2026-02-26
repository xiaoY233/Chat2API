/**
 * Provider State Management
 * Uses zustand to manage provider and account state
 */

import { create } from 'zustand'
import type { 
  Provider, 
  Account, 
  ProviderStatus,
  BuiltinProviderConfig,
} from '@/types/electron'

interface ProviderState {
  providers: Provider[]
  builtinProviders: BuiltinProviderConfig[]
  accounts: Account[]
  providerStatuses: Record<string, ProviderStatus>
  accountCounts: Record<string, { total: number; active: number }>
  isLoading: boolean
  selectedProviderId: string | null
  selectedAccountId: string | null
  
  setProviders: (providers: Provider[]) => void
  setBuiltinProviders: (providers: BuiltinProviderConfig[]) => void
  setAccounts: (accounts: Account[]) => void
  setProviderStatuses: (statuses: Record<string, ProviderStatus>) => void
  setAccountCounts: (counts: Record<string, { total: number; active: number }>) => void
  setIsLoading: (loading: boolean) => void
  setSelectedProviderId: (id: string | null) => void
  setSelectedAccountId: (id: string | null) => void
  
  addProvider: (provider: Provider) => void
  updateProvider: (id: string, updates: Partial<Provider>) => void
  removeProvider: (id: string) => void
  
  addAccount: (account: Account) => void
  updateAccount: (id: string, updates: Partial<Account>) => void
  removeAccount: (id: string) => void
  
  updateProviderStatus: (id: string, status: ProviderStatus) => void
  updateAccountCount: (providerId: string, total: number, active: number) => void
  
  getProviderById: (id: string) => Provider | undefined
  getAccountById: (id: string) => Account | undefined
  getAccountsByProvider: (providerId: string) => Account[]
}

export const useProvidersStore = create<ProviderState>((set, get) => ({
  providers: [],
  builtinProviders: [],
  accounts: [],
  providerStatuses: {},
  accountCounts: {},
  isLoading: false,
  selectedProviderId: null,
  selectedAccountId: null,
  
  setProviders: (providers) => set({ providers }),
  setBuiltinProviders: (builtinProviders) => set({ builtinProviders }),
  setAccounts: (accounts) => set({ accounts }),
  setProviderStatuses: (providerStatuses) => set({ providerStatuses }),
  setAccountCounts: (accountCounts) => set({ accountCounts }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setSelectedProviderId: (selectedProviderId) => set({ selectedProviderId }),
  setSelectedAccountId: (selectedAccountId) => set({ selectedAccountId }),
  
  addProvider: (provider) => set((state) => ({
    providers: [...state.providers, provider],
  })),
  
  updateProvider: (id, updates) => set((state) => ({
    providers: state.providers.map((p) => 
      p.id === id ? { ...p, ...updates } : p
    ),
  })),
  
  removeProvider: (id) => set((state) => ({
    providers: state.providers.filter((p) => p.id !== id),
    accounts: state.accounts.filter((a) => a.providerId !== id),
  })),
  
  addAccount: (account) => set((state) => ({
    accounts: [...state.accounts, account],
  })),
  
  updateAccount: (id, updates) => set((state) => ({
    accounts: state.accounts.map((a) => 
      a.id === id ? { ...a, ...updates } : a
    ),
  })),
  
  removeAccount: (id) => set((state) => ({
    accounts: state.accounts.filter((a) => a.id !== id),
  })),
  
  updateProviderStatus: (id, status) => set((state) => ({
    providerStatuses: {
      ...state.providerStatuses,
      [id]: status,
    },
  })),
  
  updateAccountCount: (providerId, total, active) => set((state) => ({
    accountCounts: {
      ...state.accountCounts,
      [providerId]: { total, active },
    },
  })),
  
  getProviderById: (id) => get().providers.find((p) => p.id === id),
  getAccountById: (id) => get().accounts.find((a) => a.id === id),
  getAccountsByProvider: (providerId) => get().accounts.filter((a) => a.providerId === providerId),
}))

export default useProvidersStore
