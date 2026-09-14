import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('../views/LoginPage.vue'), meta: { guest: true } },
  {
    path: '/',
    component: () => import('../components/layout/AppLayout.vue'),
    children: [
      { path: '', name: 'dashboard', component: () => import('../views/DashboardPage.vue'), meta: { title: 'Dashboard' } },
      { path: 'items/:id', name: 'item', component: () => import('../views/ItemPage.vue'), meta: { title: 'Item' } },
      { path: 'chats', name: 'chats', component: () => import('../views/ChatsPage.vue'), meta: { title: 'Chats' } },
      { path: 'chats/:id', name: 'chat', component: () => import('../views/ChatDetailPage.vue'), meta: { title: 'Chat' } },
      { path: 'review', name: 'review', component: () => import('../views/ReviewPage.vue'), meta: { title: 'Review' } },
      { path: 'whatsapp', name: 'whatsapp', component: () => import('../views/WhatsAppPage.vue'), meta: { title: 'WhatsApp link' } },
      { path: 'assistant/:id?', name: 'assistant', component: () => import('../views/AssistantPage.vue'), meta: { title: 'Assistant' } },
      { path: 'settings', name: 'settings', component: () => import('../views/SettingsPage.vue'), meta: { title: 'Settings' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

const router = createRouter({ history: createWebHistory(), routes })

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  if (!auth.ready) await auth.restore()
  if (to.meta.guest) return auth.isAuthenticated ? '/' : true
  if (!auth.isAuthenticated) return { path: '/login', query: { next: to.fullPath } }
  return true
})

export default router
