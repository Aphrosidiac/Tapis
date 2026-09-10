<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Sidebar from './Sidebar.vue'
import Navbar from './Navbar.vue'
import { useLinkStore } from '../../stores/link'
import { usePolling } from '../../composables/usePolling'

const route = useRoute()
const title = computed(() => (route.meta.title as string) || '')
const navOpen = ref(false)
// Navigating on a phone must close the drawer, or the new page is hidden
// behind it.
watch(() => route.fullPath, () => { navOpen.value = false })

const link = useLinkStore()
usePolling(() => link.refresh(), 20_000)
</script>

<template>
  <div class="flex min-h-screen">
    <Sidebar :open="navOpen" @close="navOpen = false" />
    <div v-if="navOpen" class="fixed inset-0 z-30 bg-ink-900/40 lg:hidden" @click="navOpen = false" />

    <div class="flex min-w-0 flex-1 flex-col">
      <Navbar :title="title" @toggle-sidebar="navOpen = !navOpen" />
      <main class="min-w-0 flex-1 px-4 py-6 lg:px-8">
        <div class="mx-auto max-w-[1280px]">
          <RouterView />
        </div>
      </main>
    </div>
  </div>
</template>
