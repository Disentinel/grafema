import { create } from 'zustand';

export interface Route {
  id: string;
  label: string;
  color: string;
  nodeIndices: number[]; // indices into dataStore.nodes
  visible: boolean;
}

export interface RouteState {
  routes: Route[];
  addRoute: (route: Omit<Route, 'visible'>) => void;
  removeRoute: (id: string) => void;
  toggleRoute: (id: string) => void;
  setRoutes: (routes: Route[]) => void;
}

export const useRouteStore = create<RouteState>((set) => ({
  routes: [],
  addRoute: (route) =>
    set((s) => ({ routes: [...s.routes, { ...route, visible: true }] })),
  removeRoute: (id) =>
    set((s) => ({ routes: s.routes.filter((r) => r.id !== id) })),
  toggleRoute: (id) =>
    set((s) => ({
      routes: s.routes.map((r) =>
        r.id === id ? { ...r, visible: !r.visible } : r,
      ),
    })),
  setRoutes: (routes) => set({ routes }),
}));
