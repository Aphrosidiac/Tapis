<script setup lang="ts">
import { useId } from 'vue'

defineProps<{
  modelValue?: string | null
  label?: string
  placeholder?: string
  rows?: number
  hint?: string
  error?: string
  required?: boolean
  disabled?: boolean
}>()
defineEmits<{ 'update:modelValue': [value: string] }>()

const id = useId()
</script>

<template>
  <div>
    <label v-if="label" :for="id" class="mb-1.5 block text-[14px] font-medium leading-5 text-ink-800">
      {{ label }}<span v-if="required" class="ml-0.5 text-danger-600" aria-hidden="true">*</span>
    </label>
    <textarea
      :id="id"
      class="field"
      :value="modelValue ?? ''"
      :placeholder="placeholder"
      :rows="rows || 3"
      :disabled="disabled"
      :aria-invalid="error ? 'true' : undefined"
      @input="$emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
    />
    <p v-if="error" class="mt-1.5 text-[13px] leading-[18px] text-danger-600">{{ error }}</p>
    <p v-else-if="hint" class="mt-1.5 text-[13px] leading-[18px] text-ink-500">{{ hint }}</p>
  </div>
</template>
