<script setup lang="ts">
defineProps<{
  modelValue?: string | number | null
  label?: string
  placeholder?: string
  type?: string
  error?: string
  hint?: string
  disabled?: boolean
  required?: boolean
  autocomplete?: string
  min?: number
  max?: number
}>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <label class="block w-full">
    <span v-if="label" class="block text-[11.5px] font-semibold text-muted mb-1">{{ label }}<span v-if="required" class="text-bad"> *</span></span>
    <input
      :value="modelValue ?? ''"
      :type="type || 'text'"
      :placeholder="placeholder"
      :disabled="disabled"
      :autocomplete="autocomplete"
      :min="min"
      :max="max"
      :class="[
        'w-full rounded px-2.5 py-1.5 text-[13px] border bg-field text-ink placeholder:text-faint',
        'focus:outline-none focus:border-ink disabled:opacity-60 disabled:bg-inert disabled:cursor-not-allowed',
        error ? 'border-bad' : 'border-line',
      ]"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <span v-if="error" class="mt-1 block text-[11.5px] text-bad">{{ error }}</span>
    <span v-else-if="hint" class="mt-1 block text-[11.5px] text-faint">{{ hint }}</span>
  </label>
</template>
