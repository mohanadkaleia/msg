import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from './App.vue'
import { initTheme } from './composables/useTheme'
import { router } from './router'
import './style.css'

// ENG-136 "Ranin" PR-D: make the theme live — apply the persisted/resolved theme so
// the reactive store drives `data-theme` after hydration (consistent with the
// pre-paint script in index.html), then mount.
initTheme()

createApp(App).use(createPinia()).use(router).mount('#app')
