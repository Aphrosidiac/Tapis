<script setup lang="ts">
defineProps<{
  modelValue?: string | number | null
  label?: string
  options: { value: string | number; label: string }[]
  placeholder?: string
  error?: string
  hint?: string
  disabled?: boolean
  required?: boolean
}>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <label class="block w-full">
    <span v-if="label" class="block text-[11.5px] font-semibold text-muted mb-1">{{ label }}<span v-if="required" class="text-bad"> *</span></span>
    <select
      :value="modelValue ?? ''"
      :disabled="disabled"
      :class="['w-full rounded px-2.5 py-1.5 pr-7 text-[13px] border bg-field text-ink appearance-none focus:outline-none focus:border-ink disabled:opacity-60 disabled:bg-inert', error ? 'border-bad' : 'border-line']"
      style="background-image: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%226%22 viewBox=%220 0 10 6%22><path d=%22M1 1l4 4 4-4%22 stroke=%22%23555555%22 fill=%22none%22 stroke-width=%221.4%22/></svg>'); background-repeat: no-repeat; background-position: right 8px center;"
      @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-if="placeholder" value="">{{ placeholder }}</option>
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <span v-if="error" class="mt-1 block text-[11.5px] text-bad">{{ error }}</span>
    <span v-else-if="hint" class="mt-1 block text-[11.5px] text-faint">{{ hint }}</span>
  </label>
</template>
