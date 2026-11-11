<template>
    <!-- Multi-line class string containing a `data-[state=open]:` variant.
         The `=` sits inside Tailwind arbitrary-variant brackets, NOT in JSX
         expression position, so the fixer must still process this string. -->
    <AccordionTrigger
        class="flex w-full items-center justify-between gap-6 py-6 text-left
               transition-colors hover:text-(--color-brand-200)
               data-[state=open]:text-(--color-ink-1000)"
    />

    <!-- Same pattern with width-first/height-first size shorthand mixed in. -->
    <button
        class="size-5 inline-flex items-center
               data-[state=active]:bg-blue-500
               p-2"
    >toggle</button>
</template>

<script setup lang="ts">
// no-op
</script>
