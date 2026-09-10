<script setup lang="ts">
import { computed } from 'vue'
import { Loader2 } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'accent'
    size?: 'sm' | 'md' | 'lg'
    loading?: boolean
    disabled?: boolean
    type?: 'button' | 'submit' | 'reset'
  }>(),
  { variant: 'primary', size: 'md', loading: false, disabled: false, type: 'button' },
)

const classes = computed(() => {
  const base = 'inline-flex items-center justify-center rounded font-semibold border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'
  const variants: Record<string, string> = {
    primary: 'bg-ink text-white border-ink hover:bg-black',
    accent: 'bg-accent text-white border-accent hover:bg-accent-strong',
    secondary: 'bg-control text-ink border-line hover:bg-control-hover',
    danger: 'bg-bad text-white border-bad hover:opacity-90',
    ghost: 'bg-transparent text-muted border-transparent hover:bg-hair hover:text-ink',
  }
  const sizes: Record<string, string> = {
    sm: 'text-[11.5px] px-2 py-1 gap-1',
    md: 'text-[12.5px] px-3 py-1.5 gap-1.5',
    lg: 'text-[13px] px-5 py-2 gap-2',
  }
  return `${base} ${variants[props.variant]} ${sizes[props.size]}`
})
</script>

<template>
  <button :class="classes" :disabled="disabled || loading" :type="type">
    <Loader2 v-if="loading" class="w-3.5 h-3.5 animate-spin" />
    <slot />
  </button>
</template>
