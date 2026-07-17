import { createRouter, createWebHistory } from 'vue-router'

import AppShell from '../components/shell/AppShell.vue'
import { useAuthStore } from '../stores/auth'
import AcceptInviteView from '../views/AcceptInviteView.vue'
import LoginView from '../views/LoginView.vue'
import OnboardingView from '../views/OnboardingView.vue'
import SetupView from '../views/SetupView.vue'
import { isTauri } from '../worker/tauri/detect'

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
    // M6-5 (ENG-170): the desktop first-run screen (server URL + workspace
    // folder). Tauri-only — the guard below sends browser navigations home
    // and desktop first-runs here.
    {
      path: '/onboarding',
      name: 'onboarding',
      component: OnboardingView,
      meta: { public: true },
    },
  ],
})

// Desktop first-run probe (M6-5), resolved once per page load. Only a Tauri
// env ever calls this, so browsers never fetch the lazy Tauri chunk.
let onboardingNeeded: Promise<boolean> | undefined

function desktopNeedsOnboarding(): Promise<boolean> {
  onboardingNeeded ??= import('../worker/tauri/boot')
    .then((m) => m.needsOnboarding())
    .catch(() => false) // an unreadable config must not wedge routing
  return onboardingNeeded
}

// Auth gate (ENG-78, R9). On the first navigation the store phase is 'unknown';
// resolve it once (init() asks the worker for status), then enforce access:
// unauthenticated → protected route redirects to /login?redirect=<path>;
// authenticated → /login or /setup redirects home.
router.beforeEach(async (to) => {
  // Desktop onboarding gate (M6-5), BEFORE the auth gate — bidirectional:
  // with no desktop config there is no server URL, so login cannot work yet —
  // every route funnels to /onboarding until the config exists; and once the
  // config exists, /onboarding is no longer a destination — it routes home
  // (then through the auth gate → login), so the post-save page load can
  // never strand the user on a fresh onboarding form. In a browser,
  // /onboarding is not a real destination either way.
  if (isTauri()) {
    const needs = await desktopNeedsOnboarding()
    if (needs && to.name !== 'onboarding') {
      return { name: 'onboarding' }
    }
    if (!needs && to.name === 'onboarding') {
      return { name: 'home' }
    }
  } else if (to.name === 'onboarding') {
    return { name: 'home' }
  }

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
