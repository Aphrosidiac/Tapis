<script setup lang="ts">
defineProps<{ modelValue?: string | null; label?: string; placeholder?: string; rows?: number; hint?: string; error?: string; required?: boolean; disabled?: boolean }>()
defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <label class="block w-full">
    <span v-if="label" class="block text-[11.5px] font-semibold text-muted mb-1">{{ label }}<span v-if="required" class="text-bad"> *</span></span>
    <textarea
      :value="modelValue ?? ''"
      :placeholder="placeholder"
      :rows="rows || 3"
      :disabled="disabled"
      :class="['w-full rounded px-2.5 py-1.5 text-[13px] border bg-field text-ink placeholder:text-faint focus:outline-none focus:border-ink disabled:bg-inert', error ? 'border-bad' : 'border-line']"
      @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
    <span v-if="error" class="mt-1 block text-[11.5px] text-bad">{{ error }}</span>
    <span v-else-if="hint" class="mt-1 block text-[11.5px] text-faint">{{ hint }}</span>
  </label>
</template>
