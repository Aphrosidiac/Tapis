<script setup lang="ts">
import { useId } from 'vue'

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

const id = useId()
</script>

<template>
  <div>
    <label v-if="label" :for="id" class="mb-1.5 block text-[14px] font-medium leading-5 text-ink-800">
      {{ label }}<span v-if="required" class="ml-0.5 text-danger-600" aria-hidden="true">*</span>
    </label>
    <input
      :id="id"
      class="field"
      :value="modelValue ?? ''"
      :type="type || 'text'"
      :placeholder="placeholder"
      :disabled="disabled"
      :autocomplete="autocomplete"
      :min="min"
      :max="max"
      :aria-invalid="error ? 'true' : undefined"
      :aria-describedby="error || hint ? `${id}-help` : undefined"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <p v-if="error" :id="`${id}-help`" class="mt-1.5 text-[13px] leading-[18px] text-danger-600">{{ error }}</p>
    <p v-else-if="hint" :id="`${id}-help`" class="mt-1.5 text-[13px] leading-[18px] text-ink-500">{{ hint }}</p>
  </div>
</template>
