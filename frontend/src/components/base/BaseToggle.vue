<script setup lang="ts">
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{ modelValue: boolean; disabled?: boolean; label?: string; size?: 'md' | 'lg' }>(),
  { disabled: false, size: 'md' },
)
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()

/// Explicit pixels: the knob travels the track's inner width minus its own,
/// and that arithmetic does not land on the spacing scale. A near miss shows
/// as the knob stopping short of the edge, which reads as a rendering bug.
const dims = computed(() =>
  props.size === 'lg'
    ? { track: 'h-6 w-11', knob: 'size-5', on: 'translate-x-5' }
    : { track: 'h-5 w-9', knob: 'size-4', on: 'translate-x-4' },
)
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="label"
    :disabled="disabled"
    class="relative inline-flex shrink-0 items-center rounded-full p-0.5 disabled:cursor-not-allowed disabled:opacity-40"
    :class="[dims.track, modelValue ? 'bg-primary-600' : 'bg-ink-300']"
    @click.stop="emit('update:modelValue', !modelValue)"
  >
    <span
      class="block rounded-full bg-white shadow-xs transition-transform duration-[120ms]"
      :class="[dims.knob, modelValue ? dims.on : 'translate-x-0']"
    />
  </button>
</template>
