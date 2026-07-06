import { defineStore } from 'pinia'
import { ref } from 'vue'

// Pinia store stub (D-7). Real stores fed by worker postMessage RPC land in
// ENG-82; this exists so the Pinia + Vitest wiring has real content to test.
export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)

  function increment(): void {
    count.value += 1
  }

  return { count, increment }
})
