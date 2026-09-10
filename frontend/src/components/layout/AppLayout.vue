<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Sidebar from './Sidebar.vue'
import Navbar from './Navbar.vue'
import { useLinkStore } from '../../stores/link'
import { usePolling } from '../../composables/usePolling'

const route = useRoute()
const title = computed(() => (route.meta.title as string) || '')
const sidebarOpen = ref(false)
watch(() => route.path, () => { sidebarOpen.value = false })

const link = useLinkStore()
usePolling(() => link.refresh(), 20_000)
</script>

<template>
  <div class="min-h-screen bg-canvas">
    <div v-if="sidebarOpen" class="fixed inset-0 z-40 bg-ink/40 lg:hidden" @click="sidebarOpen = false" />
    <Sidebar :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'" @close="sidebarOpen = false" />
    <div class="lg:ml-56">
      <Navbar :title="title" @toggle-sidebar="sidebarOpen = !sidebarOpen" />
      <main class="mx-auto max-w-[1400px] p-4 sm:p-6">
        <RouterView />
      </main>
    </div>
  </div>
</template>
