/**
 * System Prompts State Management
 * Simplified store for built-in prompts only
 */

import { create } from 'zustand'
import type { SystemPrompt, PromptType } from '@/types/electron'

interface PromptsState {
  prompts: SystemPrompt[]
  builtinPrompts: SystemPrompt[]
  selectedPrompt: SystemPrompt | null
  isLoading: boolean
  error: string | null
  
  setPrompts: (prompts: SystemPrompt[]) => void
  setBuiltinPrompts: (prompts: SystemPrompt[]) => void
  setSelectedPrompt: (prompt: SystemPrompt | null) => void
  setIsLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  
  fetchPrompts: () => Promise<void>
  fetchBuiltinPrompts: () => Promise<void>
  
  getPromptById: (id: string) => SystemPrompt | undefined
  getPromptsByType: (type: PromptType) => SystemPrompt[]
  
  getPromptStats: () => {
    total: number
    builtin: number
    byType: Record<PromptType, number>
  }
}

export const usePromptsStore = create<PromptsState>((set, get) => ({
  prompts: [],
  builtinPrompts: [],
  selectedPrompt: null,
  isLoading: false,
  error: null,
  
  setPrompts: (prompts) => set({ prompts }),
  setBuiltinPrompts: (builtinPrompts) => set({ builtinPrompts }),
  setSelectedPrompt: (selectedPrompt) => set({ selectedPrompt }),
  setIsLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
  
  fetchPrompts: async () => {
    set({ isLoading: true, error: null })
    try {
      const prompts = await window.electronAPI.prompts.getAll()
      const builtinPrompts = prompts.filter(p => p.isBuiltin)
      set({ prompts, builtinPrompts, isLoading: false })
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false })
    }
  },
  
  fetchBuiltinPrompts: async () => {
    try {
      const builtinPrompts = await window.electronAPI.prompts.getBuiltin()
      set({ builtinPrompts })
    } catch (error) {
      set({ error: (error as Error).message })
    }
  },
  
  getPromptById: (id) => get().prompts.find((p) => p.id === id),
  
  getPromptsByType: (type) => get().prompts.filter((p) => p.type === type),
  
  getPromptStats: () => {
    const { prompts, builtinPrompts } = get()
    const byType: Record<PromptType, number> = {
      general: 0,
      'tool-use': 0,
      agent: 0,
      translation: 0,
      search: 0,
    }
    
    prompts.forEach((p) => {
      byType[p.type]++
    })
    
    return {
      total: prompts.length,
      builtin: builtinPrompts.length,
      byType,
    }
  },
}))

export default usePromptsStore
