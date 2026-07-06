import { createRouter, createWebHistory } from 'vue-router'

import HomeView from '../views/HomeView.vue'

// History mode (D-4): deep links like /channel/abc are client routes; the
// FastAPI SPA fallback (SPAStaticFiles) returns index.html for them in prod.
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
  ],
})
