import '@fontsource/spline-sans/400.css'
import '@fontsource/spline-sans/500.css'
import '@fontsource/spline-sans/600.css'
import '@fontsource/sometype-mono/400.css'
import '@fontsource/sometype-mono/600.css'
import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router.js'
import './styles.css'

createApp(App).use(router).mount('#app')
