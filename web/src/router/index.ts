import { createRouter, createWebHistory } from 'vue-router'

import AppShell from '../components/shell/AppShell.vue'
import { useAuthStore } from '../stores/auth'
import AcceptInviteView from '../views/AcceptInviteView.vue'
import LoginView from '../views/LoginView.vue'
import SetupView from '../views/SetupView.vue'

// History mode (D-4): deep links like /channel/abc are client routes; the
// FastAPI SPA fallback (SPAStaticFiles) returns index.html for them in prod.
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    // Authed app shell (ENG-82; ENG-136 "Ranin" PR-C): the AppShell CSS-grid
    // assembly — SpaceRail | sidebar | virtualized message list + composer |
    // thread drawer, with Cmd+K.
    { path: '/', name: 'home', component: AppShell },
    // Public auth routes (ENG-78).
    { path: '/login', name: 'login', component: LoginView, meta: { public: true } },
    { path: '/setup', name: 'setup', component: SetupView, meta: { public: true } },
    {
      path: '/join/:token',
      name: 'join',
      component: AcceptInviteView,
      meta: { public: true },
    },
  ],
})

// Auth gate (ENG-78, R9). On the first navigation the store phase is 'unknown';
// resolve it once (init() asks the worker for status), then enforce access:
// unauthenticated → protected route redirects to /login?redirect=<path>;
// authenticated → /login or /setup redirects home.
router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (auth.phase === 'unknown') {
    try {
      await auth.init()
    } catch {
      // A worker/status failure must not wedge routing — fall through as anonymous.
    }
  }

  const isPublic = to.meta.public === true

  if (auth.phase !== 'authenticated' && !isPublic) {
    return { name: 'login', query: { redirect: to.fullPath } }
  }
  if (auth.phase === 'authenticated' && (to.name === 'login' || to.name === 'setup')) {
    return { name: 'home' }
  }
  return true
})
