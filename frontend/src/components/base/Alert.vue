<script setup lang="ts">
import { computed } from 'vue'
import { AlertTriangle, Info, CircleAlert, CircleCheck } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{ tone?: 'info' | 'warning' | 'danger' | 'success'; title: string }>(),
  { tone: 'info' },
)

/// The band is tinted and the sentence is ink. Setting the one line a person
/// must not miss in warning-600 on warning-50 measures 3.4:1 and makes it the
/// least legible text on the screen.
const skin = computed(
  () =>
    ({
      info: ['border-info-600/25 bg-info-50', 'text-info-600', Info],
      warning: ['border-warning-600/25 bg-warning-50', 'text-warning-600', AlertTriangle],
      danger: ['border-danger-600/25 bg-danger-50', 'text-danger-600', CircleAlert],
      success: ['border-success-600/25 bg-success-50', 'text-success-600', CircleCheck],
    })[props.tone],
)
</script>

<template>
  <div class="flex gap-3 rounded-md border px-4 py-3.5" :class="skin[0]" role="alert">
    <component :is="skin[2]" class="mt-px size-4 shrink-0" :class="skin[1]" :stroke-width="1.75" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="text-[14px] font-semibold leading-5" :class="skin[1]">{{ title }}</p>
      <div v-if="$slots.default" class="mt-1 text-[14px] leading-5 text-ink-600"><slot /></div>
    </div>
    <div v-if="$slots.action" class="shrink-0"><slot name="action" /></div>
  </div>
</template>
