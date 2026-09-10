<script setup lang="ts">
import { useId } from 'vue'

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

const id = useId()
</script>

<template>
  <div>
    <label v-if="label" :for="id" class="mb-1.5 block text-[14px] font-medium leading-5 text-ink-800">
      {{ label }}<span v-if="required" class="ml-0.5 text-danger-600" aria-hidden="true">*</span>
    </label>
    <select
      :id="id"
      class="field appearance-none pr-8"
      :value="modelValue ?? ''"
      :disabled="disabled"
      style="background-image: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%226%22 viewBox=%220 0 10 6%22><path d=%22M1 1l4 4 4-4%22 stroke=%22%235c7480%22 fill=%22none%22 stroke-width=%221.5%22 stroke-linecap=%22round%22/></svg>'); background-repeat: no-repeat; background-position: right 12px center"
      @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-if="placeholder" value="">{{ placeholder }}</option>
      <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
    </select>
    <p v-if="error" class="mt-1.5 text-[13px] leading-[18px] text-danger-600">{{ error }}</p>
    <p v-else-if="hint" class="mt-1.5 text-[13px] leading-[18px] text-ink-500">{{ hint }}</p>
  </div>
</template>
