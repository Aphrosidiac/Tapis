<script setup lang="ts">
withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'
    size?: 'sm' | 'md' | 'lg'
    loading?: boolean
    disabled?: boolean
    block?: boolean
    type?: 'button' | 'submit' | 'reset'
  }>(),
  { variant: 'secondary', size: 'md', type: 'button' },
)
</script>

<template>
  <!-- The primary action is ink, not the accent: white on primary-600 is
       4.2:1 and fails AA for a 15px label. -->
  <button
    :type="type"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
    class="inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
    :class="[
      block && 'w-full',
      size === 'sm'
        ? 'h-[38px] px-3 text-[14px] sm:h-[30px] sm:px-2.5'
        : size === 'lg'
          ? 'h-11 px-[18px] text-[16px]'
          : 'h-[42px] px-4 text-[15px] sm:h-[38px] sm:px-3.5',
      variant === 'primary' && 'bg-ink-900 text-white hover:bg-ink-800 active:bg-black',
      variant === 'secondary' && 'border border-line-200 bg-surface-0 text-ink-800 hover:bg-surface-50 active:bg-line-100',
      variant === 'ghost' && 'text-ink-600 hover:bg-surface-50 hover:text-ink-900',
      variant === 'danger' && 'bg-danger-600 text-white hover:bg-danger-700',
      variant === 'danger-ghost' && 'border border-line-200 text-danger-600 hover:bg-danger-50',
    ]"
  >
    <svg v-if="loading" class="size-4 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" opacity=".25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" />
    </svg>
    <slot />
  </button>
</template>
