import { create } from 'zustand'

type NavigationBlocker = {
  id: string
  message: string
}

interface NavigationState {
  blockers: NavigationBlocker[]
  pendingNavigation: (() => void) | null
  isDialogOpen: boolean
  
  registerBlocker: (id: string, message: string) => void
  unregisterBlocker: (id: string) => void
  setPendingNavigation: (navigation: (() => void) | null) => void
  confirmNavigation: () => void
  cancelNavigation: () => void
  hasBlockers: () => boolean
}

export const useNavigationStore = create<NavigationState>((set, get) => ({
  blockers: [],
  pendingNavigation: null,
  isDialogOpen: false,

  registerBlocker: (id, message) => {
    set((state) => ({
      blockers: state.blockers.some(b => b.id === id)
        ? state.blockers.map(b => b.id === id ? { ...b, message } : b)
        : [...state.blockers, { id, message }]
    }))
  },

  unregisterBlocker: (id) => {
    set((state) => ({
      blockers: state.blockers.filter(b => b.id !== id),
      isDialogOpen: state.blockers.length > 1 || (state.blockers.length === 1 && state.blockers[0]?.id !== id) ? state.isDialogOpen : false
    }))
  },

  setPendingNavigation: (navigation) => {
    const { blockers } = get()
    if (blockers.length > 0 && navigation) {
      set({ pendingNavigation: navigation, isDialogOpen: true })
    } else if (navigation) {
      navigation()
    }
  },

  confirmNavigation: () => {
    const { pendingNavigation } = get()
    pendingNavigation?.()
    set({ pendingNavigation: null, isDialogOpen: false })
  },

  cancelNavigation: () => {
    set({ pendingNavigation: null, isDialogOpen: false })
  },

  hasBlockers: () => get().blockers.length > 0,
}))

export default useNavigationStore
