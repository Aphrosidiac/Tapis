<script setup lang="ts">
import { computed } from 'vue'
const props = withDefaults(defineProps<{ modelValue: boolean; disabled?: boolean; label?: string; size?: 'md' | 'lg' }>(), { disabled: false, size: 'md' })
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()
const dims = computed(() =>
  props.size === 'lg'
    ? { track: 'h-[28px] w-[52px]', knob: 'h-[22px] w-[22px]', on: 'translate-x-[24px]' }
    : { track: 'h-[22px] w-[40px]', knob: 'h-[16px] w-[16px]', on: 'translate-x-[18px]' },
)
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    :class="['relative inline-flex shrink-0 items-center rounded-full border p-0.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ink/25 disabled:cursor-not-allowed disabled:opacity-40', dims.track, modelValue ? 'border-accent bg-accent' : 'border-line bg-control']"
    @click.stop="emit('update:modelValue', !modelValue)"
  >
    <span :class="['block rounded-full bg-white transition-transform duration-150', dims.knob, modelValue ? dims.on : 'translate-x-0 border border-line']" />
  </button>
</template>
