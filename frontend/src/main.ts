import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import '@fontsource-variable/plus-jakarta-sans'
import './main.css'

createApp(App).use(createPinia()).use(router).mount('#app')
