import { createRouter, createWebHistory } from 'vue-router'
import LandingView from './views/LandingView.vue'
import DashboardView from './views/DashboardView.vue'
import RepositoryView from './views/RepositoryView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: LandingView },
    { path: '/dashboards/:id', name: 'dashboard', component: DashboardView },
    { path: '/repository', name: 'repository', component: RepositoryView },
  ],
  scrollBehavior: () => ({ top: 0 }),
})
