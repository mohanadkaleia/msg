<script setup lang="ts">
import { storeToRefs } from 'pinia'

import HelloWorld from '../components/HelloWorld.vue'
import { useCounterStore } from '../stores/counter'

const counter = useCounterStore()
const { count } = storeToRefs(counter)
</script>

<template>
  <main class="p-8">
    <HelloWorld msg="msg web client" />
    <p class="mt-4">Count: {{ count }}</p>
    <button
      type="button"
      class="mt-2 rounded bg-slate-800 px-3 py-1 text-white"
      @click="counter.increment"
    >
      Increment
    </button>
  </main>
</template>
