<template>
    <!-- w-screen is 100vw and h-screen is 100vh; Tailwind has no size-screen, so these must stay -->
    <div class="w-screen h-screen bg-black"></div>
    <div class="h-screen w-screen"></div>
    <div class="md:w-screen md:h-screen"></div>
    <!-- control: a value size- does define still merges -->
    <div class="w-full h-full"></div>
</template>

<script setup lang="ts">
// no-op
</script>
